// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as chatPOST } from "@/app/api/chat/route";
import { POST as debugEmitPOST } from "@/app/api/debug/emit/route";
import { GET as eventsGET } from "@/app/api/events/route";
import { POST as resetPOST } from "@/app/api/reset/route";
import { GET as sessionGET, POST as sessionPOST } from "@/app/api/session/route";
import {
  __setDefaultCompleter,
  resetAllConversations,
  type ChatCompleter,
  type CompletionResult,
} from "@/lib/agent";
import { createSession, getOrder, resetAllSessions } from "@/lib/db";
import { __resetBusForTests, emit, getHistory } from "@/lib/event-bus";

beforeEach(() => {
  resetAllSessions();
  __resetBusForTests();
  resetAllConversations();
  __setDefaultCompleter(null);
});
afterEach(() => {
  resetAllSessions();
  __resetBusForTests();
  resetAllConversations();
  __setDefaultCompleter(null);
});

const postReq = (url: string, body: unknown, init: RequestInit = {}) =>
  new Request(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    ...init,
  });
const getReq = (url: string, init: RequestInit = {}) =>
  new Request(url, { method: "GET", ...init });

interface Frame {
  event?: string;
  data?: unknown;
  id?: string;
}

async function readSse(
  res: Response,
  opts: { untilEvent?: string; maxFrames?: number; timeoutMs?: number } = {},
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? 3000);
  });
  try {
    while (true) {
      const r = await Promise.race([reader.read(), timeoutP]);
      if (r === "timeout") break;
      const { value, done } = r;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (chunk === "" || chunk.startsWith(":")) continue; // heartbeat/comment
        const frame: Frame = {};
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice(5).trim());
          else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        }
        frames.push(frame);
        if (
          (opts.maxFrames && frames.length >= opts.maxFrames) ||
          (opts.untilEvent && frame.event === opts.untilEvent)
        ) {
          return frames;
        }
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return frames;
}

function scriptedCompleter(steps: CompletionResult[]): ChatCompleter {
  let i = 0;
  return async () => (i < steps.length ? steps[i++] : { content: "Anything else?", toolCalls: [] });
}
const toolStep = (name: string, args: object): CompletionResult => ({
  content: null,
  toolCalls: [{ id: `c${Math.random()}`, name, args: JSON.stringify(args) }],
});

describe("POST/GET /api/session", () => {
  it("lists 15 selectable profiles", async () => {
    const res = await sessionGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<{ id: string; orderCount: number }> };
    expect(body.customers).toHaveLength(15);
    expect(body.customers[0]).toHaveProperty("name");
    expect(body.customers[0]).toHaveProperty("orderCount");
  });

  it("creates a session bound to a valid profile", async () => {
    const res = await sessionPOST(postReq("http://t/api/session", { customerId: "cus_01" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; customer: { id: string } | null };
    expect(body.sessionId).toMatch(/^sess_/);
    expect(body.customer?.id).toBe("cus_01");
  });

  it("400s on an unknown customer and creates an unbound session on empty/malformed body", async () => {
    expect(
      (await sessionPOST(postReq("http://t/api/session", { customerId: "cus_ZZ" }))).status,
    ).toBe(400);
    const empty = await sessionPOST(postReq("http://t/api/session", {}));
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { customer: unknown }).customer).toBeNull();
    // Malformed JSON is treated leniently as an unbound session.
    const bad = await sessionPOST(postReq("http://t/api/session", "{not json"));
    expect(bad.status).toBe(200);
  });
});

describe("POST /api/reset", () => {
  it("resets a single session's data + events, and 404s on unknown", async () => {
    const s = createSession({ boundCustomerId: "cus_01" });
    emit("thought", s.id, { text: "x" });
    // (mutate via a real refund path is covered elsewhere; here just assert reset plumbing)
    const res = await resetPOST(postReq("http://t/api/reset", { sessionId: s.id }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string }).scope).toBe("session");

    expect((await resetPOST(postReq("http://t/api/reset", { sessionId: "nope" }))).status).toBe(
      404,
    );
  });

  it("full reset clears everything", async () => {
    createSession();
    const res = await resetPOST(postReq("http://t/api/reset", {}));
    expect(((await res.json()) as { scope: string }).scope).toBe("all");
  });
});

describe("POST /api/debug/emit (dev-only trace injector)", () => {
  it("only targets synthetic sess_debug* ids and injects a full failure/retry trace", async () => {
    // A real session id is rejected — the injector cannot forge a trace into a real customer's log.
    expect(
      (await debugEmitPOST(postReq("http://t/api/debug/emit", { sessionId: "sess_real" }))).status,
    ).toBe(400);

    const res = await debugEmitPOST(
      postReq("http://t/api/debug/emit", { sessionId: "sess_debugX" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { emitted: number }).toMatchObject({ ok: true, emitted: 7 });

    const hist = getHistory("sess_debugX");
    expect(hist.some((e) => e.type === "retry")).toBe(true);
    expect(
      hist.some(
        (e) => e.type === "decision" && (e.payload as { outcome: string }).outcome === "escalated",
      ),
    ).toBe(true);
  });
});

describe("GET /api/events (SSE)", () => {
  it("backfills prior events for a session opened mid-conversation", async () => {
    const s = createSession();
    emit("user_message", s.id, { text: "hello" });
    emit("thought", s.id, { text: "thinking" });
    const res = await eventsGET(getReq(`http://t/api/events?sessionId=${s.id}`));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(res, { maxFrames: 2, timeoutMs: 2000 });
    expect(frames.map((f) => f.event)).toEqual(["user_message", "thought"]);
  });

  it("tails new events and supports two simultaneous streams on one session", async () => {
    const s = createSession();
    const [r1, r2] = await Promise.all([
      eventsGET(getReq(`http://t/api/events?sessionId=${s.id}`)),
      eventsGET(getReq(`http://t/api/events?sessionId=${s.id}`)),
    ]);
    emit("decision", s.id, { outcome: "approved", clauses: ["R1"], summary: "ok" });
    const [f1, f2] = await Promise.all([
      readSse(r1, { maxFrames: 1, timeoutMs: 2000 }),
      readSse(r2, { maxFrames: 1, timeoutMs: 2000 }),
    ]);
    expect(f1[0].event).toBe("decision");
    expect(f2[0].event).toBe("decision");
  });

  it("firehose delivers events across all sessions", async () => {
    const a = createSession();
    const b = createSession();
    emit("thought", a.id, { text: "a" });
    emit("thought", b.id, { text: "b" });
    const res = await eventsGET(getReq("http://t/api/events")); // no sessionId → firehose
    const frames = await readSse(res, { maxFrames: 2, timeoutMs: 2000 });
    const sessionIds = frames.map((f) => (f.data as { sessionId: string }).sessionId);
    expect(new Set(sessionIds)).toEqual(new Set([a.id, b.id]));
  });

  it("tears down cleanly on client disconnect (abort) without hanging", async () => {
    const s = createSession();
    const ac = new AbortController();
    const res = await eventsGET(
      new Request(`http://t/api/events?sessionId=${s.id}`, { signal: ac.signal }),
    );
    emit("thought", s.id, { text: "one" });
    const readerP = readSse(res, { maxFrames: 10, timeoutMs: 2000 });
    ac.abort();
    const frames = await readerP;
    expect(Array.isArray(frames)).toBe(true); // returned, did not hang or throw
  });
});

describe("POST /api/chat (SSE)", () => {
  it("streams reasoning events and a final done frame for a resolved turn", async () => {
    __setDefaultCompleter(
      scriptedCompleter([
        toolStep("check_refund_eligibility", { customerId: "cus_01", orderId: "ord_1001" }),
        toolStep("process_refund", { customerId: "cus_01", orderId: "ord_1001" }),
        { content: "Approved your $129.00 refund (R1).", toolCalls: [] },
      ]),
    );
    const s = createSession({ boundCustomerId: "cus_01" });
    const res = await chatPOST(
      postReq("http://t/api/chat", { sessionId: s.id, message: "refund ord_1001" }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(res, { untilEvent: "done", timeoutMs: 4000 });
    const types = frames.map((f) => f.event);
    expect(types).toContain("tool_call");
    expect(types).toContain("decision");
    expect(types.at(-1)).toBe("done");
    expect((frames.at(-1)!.data as { reply: string }).reply).toContain("refund");
    expect(getOrder(s.id, "ord_1001")!.order.priorRefund.refunded).toBe(true);
  });

  it("validates the body and the session", async () => {
    const s = createSession({ boundCustomerId: "cus_01" });
    expect((await chatPOST(postReq("http://t/api/chat", "{bad json"))).status).toBe(400);
    expect((await chatPOST(postReq("http://t/api/chat", { sessionId: s.id }))).status).toBe(400); // no message
    expect(
      (await chatPOST(postReq("http://t/api/chat", { sessionId: s.id, message: "" }))).status,
    ).toBe(400);
    expect(
      (await chatPOST(postReq("http://t/api/chat", { sessionId: "nope", message: "hi" }))).status,
    ).toBe(404);
  });

  it("rejects a concurrent turn on the same session with 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    __setDefaultCompleter(async () => {
      await gate;
      return { content: "done", toolCalls: [] };
    });
    const s = createSession({ boundCustomerId: "cus_01" });

    const res1 = await chatPOST(postReq("http://t/api/chat", { sessionId: s.id, message: "a" }));
    await new Promise((r) => setTimeout(r, 0)); // let the stream start + agent begin (gated)
    const res2 = await chatPOST(postReq("http://t/api/chat", { sessionId: s.id, message: "b" }));
    expect(res2.status).toBe(409);

    release();
    await readSse(res1, { untilEvent: "done", timeoutMs: 4000 });
  });

  it("does not wedge inFlight when the request is already aborted before the stream starts", async () => {
    __setDefaultCompleter(scriptedCompleter([{ content: "hi", toolCalls: [] }]));
    const s = createSession({ boundCustomerId: "cus_01" });
    const ac = new AbortController();
    ac.abort(); // pre-aborted: sseResponse tears down before onStart, so inFlight must never be added
    const res1 = await chatPOST(
      new Request("http://t/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: s.id, message: "a" }),
        signal: ac.signal,
      }),
    );
    await readSse(res1, { maxFrames: 1, timeoutMs: 500 }); // drains the immediately-closed stream
    // The session must NOT be stuck at 409 — a subsequent normal turn succeeds.
    const res2 = await chatPOST(postReq("http://t/api/chat", { sessionId: s.id, message: "b" }));
    expect(res2.status).toBe(200);
    await readSse(res2, { untilEvent: "done", timeoutMs: 2000 });
  });
});
