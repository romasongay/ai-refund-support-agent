import { afterEach, describe, expect, it } from "vitest";
import { createEvent, ReasoningEventSchema } from "@/lib/events";
import {
  __resetBusForTests,
  clearSessionEvents,
  emit,
  getFirehoseHistory,
  getHistory,
  MAX_EVENTS_PER_SESSION,
  subscribe,
} from "@/lib/event-bus";

afterEach(() => __resetBusForTests());

describe("reasoning event schema", () => {
  it("builds and validates a well-formed event", () => {
    const e = createEvent("thought", "sess_1", { text: "hi" }, { id: "e1", ts: 1 });
    expect(ReasoningEventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ id: "e1", ts: 1, type: "thought", sessionId: "sess_1" });
  });

  it("rejects an unknown type and a malformed payload", () => {
    expect(
      ReasoningEventSchema.safeParse({ id: "x", sessionId: "s", ts: 0, type: "nope", payload: {} })
        .success,
    ).toBe(false);
    // decision payload requires clauses + summary
    expect(
      ReasoningEventSchema.safeParse({
        id: "x",
        sessionId: "s",
        ts: 0,
        type: "decision",
        payload: { outcome: "approved" },
      }).success,
    ).toBe(false);
  });
});

describe("event bus", () => {
  it("publishes, stores history, and fans out to session + firehose subscribers", () => {
    const seen: string[] = [];
    const fire: string[] = [];
    const off1 = subscribe("sess_1", (e) => seen.push(e.type));
    const off2 = subscribe("*", (e) => fire.push(e.sessionId));

    emit("user_message", "sess_1", { text: "hello" });
    emit("thought", "sess_2", { text: "elsewhere" });

    expect(seen).toEqual(["user_message"]); // session sub only sees its session
    expect(fire).toEqual(["sess_1", "sess_2"]); // firehose sees every session
    expect(getHistory("sess_1")).toHaveLength(1);

    off1();
    off2();
    emit("thought", "sess_1", { text: "after-unsub" });
    expect(seen).toHaveLength(1); // no longer notified
    expect(getHistory("sess_1")).toHaveLength(2); // but history still records
  });

  it("isolates a misbehaving subscriber (does not break publishing)", () => {
    subscribe("sess_x", () => {
      throw new Error("boom");
    });
    expect(() => emit("thought", "sess_x", { text: "ok" })).not.toThrow();
    expect(getHistory("sess_x")).toHaveLength(1);
  });

  it("caps per-session history to MAX_EVENTS_PER_SESSION", () => {
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 50; i++) {
      emit("thought", "sess_cap", { text: String(i) });
    }
    const h = getHistory("sess_cap");
    expect(h.length).toBe(MAX_EVENTS_PER_SESSION);
    // Oldest were dropped; newest retained.
    expect((h[h.length - 1].payload as { text: string }).text).toBe(
      String(MAX_EVENTS_PER_SESSION + 49),
    );
  });
});

describe("firehose backfill (merged per-session histories)", () => {
  it("returns every session's events in one global chronological order", () => {
    const a = emit("user_message", "sess_a", { text: "a1" });
    const b = emit("thought", "sess_b", { text: "b1" });
    const c = emit("thought", "sess_a", { text: "a2" });
    expect(getFirehoseHistory().map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it("resumes strictly after a known Last-Event-ID (no re-streaming on reconnect)", () => {
    const e1 = emit("thought", "s1", { text: "1" });
    const e2 = emit("thought", "s2", { text: "2" });
    const e3 = emit("thought", "s1", { text: "3" });
    expect(getFirehoseHistory(e1.id).map((e) => e.id)).toEqual([e2.id, e3.id]);
    // An unknown/absent id replays the whole (bounded) log rather than dropping everything.
    expect(getFirehoseHistory("does-not-exist")).toHaveLength(3);
    expect(getFirehoseHistory()).toHaveLength(3);
  });

  it("keeps a session's full history backfillable regardless of other sessions' volume", () => {
    // Regression guard: an early low-volume session must not be evicted from the firehose backfill by
    // later high-volume sessions (there is no lossy global cap — the merge is over per-session history).
    const early = emit("user_message", "sess_early", { text: "the important opening message" });
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 100; i++) {
      emit("thought", "sess_busy", { text: String(i) });
    }
    const firehose = getFirehoseHistory();
    // The busy session is capped per-session, but the early session's event is still present…
    expect(firehose.some((e) => e.id === early.id)).toBe(true);
    // …and still first in global order.
    expect(firehose[0].id).toBe(early.id);
    expect(firehose.filter((e) => e.sessionId === "sess_busy")).toHaveLength(
      MAX_EVENTS_PER_SESSION,
    );
  });

  it("drops a cleared session from the firehose log", () => {
    emit("thought", "keep", { text: "k" });
    emit("thought", "drop", { text: "d" });
    clearSessionEvents("drop");
    expect(getFirehoseHistory().map((e) => e.sessionId)).toEqual(["keep"]);
    expect(getHistory("drop")).toHaveLength(0);
  });
});
