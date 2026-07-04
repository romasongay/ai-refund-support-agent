import { afterEach, describe, expect, it } from "vitest";
import { createEvent, ReasoningEventSchema } from "@/lib/events";
import {
  __resetBusForTests,
  emit,
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
