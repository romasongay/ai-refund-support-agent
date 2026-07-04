/**
 * Real-server smoke for the API layer. Requires the dev server running (npm run dev).
 * Run: npx tsx scripts/smoke-api.mts   (uses gpt-4o-mini via /api/chat)
 *
 * Exercises the full HTTP + SSE stack in the real Next 16 runtime: list profiles, create a session,
 * stream a chat turn to a `done` frame, backfill the event feed, and reset.
 */
const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

interface Frame {
  event?: string;
  data?: unknown;
}

async function readSse(
  res: Response,
  opts: { untilEvent?: string; maxFrames?: number; timeoutMs?: number } = {},
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const deadline = Date.now() + (opts.timeoutMs ?? 40000);
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!chunk || chunk.startsWith(":")) continue;
      const frame: Frame = {};
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice(5).trim());
      }
      frames.push(frame);
      if (
        (opts.maxFrames && frames.length >= opts.maxFrames) ||
        (opts.untilEvent && frame.event === opts.untilEvent)
      ) {
        await reader.cancel();
        return frames;
      }
    }
  }
  await reader.cancel();
  return frames;
}

const postJson = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

try {
  const profiles = (await (await fetch(`${BASE}/api/session`)).json()) as { customers?: unknown[] };
  console.log("profiles:", profiles.customers?.length);

  const sess = (await (await postJson("/api/session", { customerId: "cus_01" })).json()) as {
    sessionId: string;
    customer?: { name?: string };
  };
  console.log("session:", sess.sessionId, "→", sess.customer?.name);

  const chatRes = await postJson("/api/chat", {
    sessionId: sess.sessionId,
    message: "Hi, please refund my order ord_1001.",
  });
  console.log("chat:", chatRes.status, chatRes.headers.get("content-type"));
  const chatFrames = await readSse(chatRes, { untilEvent: "done" });
  const types = chatFrames.map((f) => f.event);
  const done = chatFrames.find((f) => f.event === "done");
  const decision = chatFrames.find((f) => f.event === "decision");
  console.log("chat event types:", types.join(", "));
  console.log("reply:", (done?.data as { reply?: string } | undefined)?.reply);
  console.log("decision:", JSON.stringify(decision?.data));

  const evRes = await fetch(`${BASE}/api/events?sessionId=${sess.sessionId}`);
  const evFrames = await readSse(evRes, { maxFrames: 3, timeoutMs: 5000 });
  console.log("event feed backfilled frames:", evFrames.length);

  const resetRes = await postJson("/api/reset", {});
  console.log("reset:", resetRes.status, JSON.stringify(await resetRes.json()));

  const ok =
    profiles.customers?.length === 15 &&
    chatRes.status === 200 &&
    types.includes("decision") &&
    types.at(-1) === "done" &&
    evFrames.length >= 1 &&
    resetRes.status === 200;
  console.log(ok ? "\nAPI SMOKE PASS" : "\nAPI SMOKE FAIL");
  process.exit(ok ? 0 : 2);
} catch (err) {
  console.error("\nAPI SMOKE ERROR (server not running? network?):", err instanceof Error ? err.message : err);
  process.exit(3);
}
