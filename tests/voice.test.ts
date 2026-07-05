// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as tokenPOST } from "@/app/api/voice/token/route";
import { POST as toolPOST } from "@/app/api/voice/tool/route";
import { POST as transcriptPOST } from "@/app/api/voice/transcript/route";
import { createSession, resetAllSessions } from "@/lib/db";
import { __resetBusForTests, getHistory } from "@/lib/event-bus";
import { realtimeTools, openaiTools } from "@/lib/tools";
import {
  __setClientSecretCreator,
  buildRealtimeSessionConfig,
  createVoiceToken,
} from "@/lib/voice/token";
import { MODELS } from "@/lib/config";

const KEY = "OPENAI_API_KEY";
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[KEY];
  resetAllSessions();
  __resetBusForTests();
  __setClientSecretCreator(null);
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY];
  else process.env[KEY] = savedKey;
  resetAllSessions();
  __resetBusForTests();
  __setClientSecretCreator(null);
});

const postReq = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("realtime tools share the text agent's tool set", () => {
  it("exposes the same 6 tools, flattened for the Realtime API", () => {
    expect(realtimeTools).toHaveLength(openaiTools.length);
    expect(new Set(realtimeTools.map((t) => t.name))).toEqual(
      new Set(openaiTools.map((t) => t.function.name)),
    );
    for (const t of realtimeTools) {
      expect(t.type).toBe("function");
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.parameters).toBeTypeOf("object");
    }
  });
});

describe("buildRealtimeSessionConfig", () => {
  it("carries the mini realtime model, shared tools, and the same policy-grounded prompt", () => {
    const s = createSession({ boundCustomerId: "cus_01" });
    const cfg = buildRealtimeSessionConfig(s);
    expect(cfg.type).toBe("realtime");
    expect(cfg.model).toBe(MODELS.realtime);
    expect(cfg.tools).toBe(realtimeTools);
    expect(cfg.tool_choice).toBe("auto");
    expect(cfg.instructions).toContain("REFUND POLICY");
    expect(cfg.instructions).toContain("cus_01"); // scoped to the signed-in customer
    // Input transcription MUST be enabled, or the customer's spoken turns never reach the chat log.
    expect(cfg.audio.input.transcription.model).toBeTruthy();
    // Noise reduction + a less-twitchy server VAD reduce spurious self-interruptions (F3).
    expect(cfg.audio.input.noise_reduction.type).toBe("near_field");
    expect(cfg.audio.input.turn_detection.type).toBe("server_vad");
  });
});

describe("createVoiceToken (seam)", () => {
  it("returns only browser-safe fields from the injected creator", async () => {
    let captured: unknown;
    __setClientSecretCreator(async (cfg) => {
      captured = cfg;
      return { value: "ek_test123", expiresAt: 1_900_000_000 };
    });
    const s = createSession({ boundCustomerId: "cus_01" });
    const token = await createVoiceToken(s);
    expect(token).toEqual({
      value: "ek_test123",
      expiresAt: 1_900_000_000,
      model: MODELS.realtime,
    });
    expect((captured as { model: string }).model).toBe(MODELS.realtime);
  });
});

describe("POST /api/voice/token", () => {
  it("503s gracefully when no API key is configured", async () => {
    delete process.env[KEY];
    const s = createSession({ boundCustomerId: "cus_01" });
    const res = await tokenPOST(postReq("http://t/api/voice/token", { sessionId: s.id }));
    expect(res.status).toBe(503);
  });

  it("validates the body and the session, and never leaks the server key", async () => {
    process.env[KEY] = "sk-should-never-be-returned";
    __setClientSecretCreator(async () => ({ value: "ek_live", expiresAt: 1_900_000_000 }));

    expect((await tokenPOST(postReq("http://t/api/voice/token", {}))).status).toBe(400);
    expect(
      (await tokenPOST(postReq("http://t/api/voice/token", { sessionId: "nope" }))).status,
    ).toBe(404);

    const s = createSession({ boundCustomerId: "cus_01" });
    const res = await tokenPOST(postReq("http://t/api/voice/token", { sessionId: s.id }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-should-never-be-returned");
    const body = JSON.parse(text) as { value: string; expiresAt: number; model: string };
    expect(body.value).toBe("ek_live");
    expect(body.model).toBe(MODELS.realtime);
    expect(body.expiresAt).toBeGreaterThan(0);
  });
});

describe("POST /api/voice/transcript (voice sessions surface on the dashboard like text)", () => {
  it("emits user_message / assistant_message and validates session + body", async () => {
    const s = createSession({ boundCustomerId: "cus_01" });
    const u = await transcriptPOST(
      postReq("http://t/api/voice/transcript", {
        sessionId: s.id,
        role: "user",
        text: "refund ord_1001 please",
      }),
    );
    expect(u.status).toBe(200);
    await transcriptPOST(
      postReq("http://t/api/voice/transcript", {
        sessionId: s.id,
        role: "assistant",
        text: "Approved your $129 refund (R1).",
      }),
    );

    const types = getHistory(s.id).map((e) => e.type);
    expect(types).toContain("user_message"); // → the session now appears in the dashboard list
    expect(types).toContain("assistant_message");

    // Validation.
    expect(
      (
        await transcriptPOST(
          postReq("http://t/api/voice/transcript", { sessionId: "nope", role: "user", text: "x" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await transcriptPOST(
          postReq("http://t/api/voice/transcript", { sessionId: s.id, role: "bogus", text: "x" }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("POST /api/voice/tool (voice tool round-trip, as a mocked realtime call would drive it)", () => {
  it("404s an unknown session and 400s a malformed body", async () => {
    expect(
      (
        await toolPOST(
          postReq("http://t/api/voice/tool", {
            sessionId: "nope",
            callId: "c1",
            name: "lookup_customer",
            arguments: "{}",
          }),
        )
      ).status,
    ).toBe(404);

    const s = createSession({ boundCustomerId: "cus_01" });
    expect((await toolPOST(postReq("http://t/api/voice/tool", { sessionId: s.id }))).status).toBe(
      400,
    );
  });

  it("runs the tool through the shared layer, emits reasoning events, and returns the output", async () => {
    const s = createSession({ boundCustomerId: "cus_01" });
    const res = await toolPOST(
      postReq("http://t/api/voice/tool", {
        sessionId: s.id,
        callId: "call_abc",
        name: "check_refund_eligibility",
        arguments: JSON.stringify({ customerId: "cus_01", orderId: "ord_1001" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { callId: string; output: string };
    expect(body.callId).toBe("call_abc");
    const verdict = JSON.parse(body.output) as { outcome: string };
    expect(verdict.outcome).toBe("approve");

    // Voice tool calls flow to the SAME reasoning bus (→ admin dashboard) as text.
    const types = getHistory(s.id).map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
  });

  it("degrades a failing tool call to an error output rather than throwing", async () => {
    const s = createSession({ boundCustomerId: "cus_01" });
    const res = await toolPOST(
      postReq("http://t/api/voice/tool", {
        sessionId: s.id,
        callId: "call_bad",
        name: "check_refund_eligibility",
        arguments: "{}", // missing required fields
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string };
    expect(body.output).toContain("error");
  });
});
