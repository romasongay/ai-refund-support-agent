import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, getOrder, resetAllSessions } from "@/lib/db";
import { __resetBusForTests, getHistory } from "@/lib/event-bus";
import type { ReasoningEvent } from "@/lib/events";
import {
  type AgentToolCall,
  type ChatCompleter,
  type CompletionResult,
  resetAllConversations,
  runAgent,
} from "@/lib/agent";

const NOW = new Date("2027-06-01T00:00:00.000Z");

beforeEach(() => {
  resetAllSessions();
  __resetBusForTests();
  resetAllConversations();
});
afterEach(() => {
  resetAllSessions();
  __resetBusForTests();
  resetAllConversations();
});

const eventsOfType = <T extends ReasoningEvent["type"]>(sid: string, type: T) =>
  getHistory(sid).filter((e): e is Extract<ReasoningEvent, { type: T }> => e.type === type);

let idc = 0;
const call = (name: string, args: object): AgentToolCall => ({
  id: `tc_${idc++}`,
  name,
  args: JSON.stringify(args),
});
const step = (toolCalls: AgentToolCall[], content: string | null = null): CompletionResult => ({
  content,
  toolCalls,
});
const finalStep = (content: string): CompletionResult => ({ content, toolCalls: [] });

/** A completer that plays a fixed script of turns; after the script it just finalizes. */
function scriptedCompleter(steps: CompletionResult[]): ChatCompleter {
  let i = 0;
  return async () => (i < steps.length ? steps[i++] : { content: "Anything else?", toolCalls: [] });
}

const run = (sid: string, msg: string, completer: ChatCompleter, extra = {}) =>
  runAgent(sid, msg, { completer, baseDelayMs: 0, ...extra });

describe("agent decision flows (mock completer)", () => {
  it("approve flow: check → process → approved decision, money moves", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    const completer = scriptedCompleter([
      step([call("check_refund_eligibility", { customerId: "cus_01", orderId: "ord_1001" })]),
      step([call("process_refund", { customerId: "cus_01", orderId: "ord_1001" })]),
      finalStep("Good news — I've approved your $129.00 refund under R1."),
    ]);
    const { reply } = await run(s.id, "refund ord_1001", completer);
    expect(reply).toContain("approved");
    const decisions = eventsOfType(s.id, "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload).toMatchObject({ outcome: "approved", clauses: ["R1"] });
    expect(getOrder(s.id, "ord_1001")!.order.priorRefund.refunded).toBe(true);
  });

  it("denial flow: check(decline) → deny → denied decision", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_02" });
    const completer = scriptedCompleter([
      step([call("check_refund_eligibility", { customerId: "cus_02", orderId: "ord_1002" })]),
      step([
        call("deny_refund", {
          customerId: "cus_02",
          orderId: "ord_1002",
          clauses: ["R1"],
          reason: "Outside the 30-day window.",
        }),
      ]),
      finalStep("I'm sorry, ord_1002 is outside the 30-day window (R1)."),
    ]);
    await run(s.id, "refund ord_1002", completer);
    expect(
      eventsOfType(s.id, "decision").some(
        (d) => d.payload.outcome === "denied" && d.payload.clauses.includes("R1"),
      ),
    ).toBe(true);
  });

  it("escalation flow: check(escalate) → escalate → escalated decision", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_05" });
    const completer = scriptedCompleter([
      step([call("check_refund_eligibility", { customerId: "cus_05", orderId: "ord_1005" })]),
      step([
        call("escalate_to_human", {
          customerId: "cus_05",
          orderId: "ord_1005",
          clauses: ["R4"],
          reason: "Order over $500 requires human review.",
        }),
      ]),
      finalStep("This order is over $500, so I've escalated it to a specialist (R4)."),
    ]);
    await run(s.id, "refund ord_1005", completer);
    expect(
      eventsOfType(s.id, "decision").some(
        (d) => d.payload.outcome === "escalated" && d.payload.clauses.includes("R4"),
      ),
    ).toBe(true);
  });
});

describe("scripted flows across all 16 requests reproduce the oracle decisions", () => {
  const FLOWS: Array<{
    cust: string;
    order: string;
    clause: string;
    decision: "approved" | "denied" | "escalated" | null;
  }> = [
    { cust: "cus_01", order: "ord_1001", clause: "R1", decision: "approved" },
    { cust: "cus_02", order: "ord_1002", clause: "R1", decision: "denied" },
    { cust: "cus_03", order: "ord_1003", clause: "R2", decision: "denied" },
    { cust: "cus_04", order: "ord_1004", clause: "R3", decision: "denied" },
    { cust: "cus_05", order: "ord_1005", clause: "R4", decision: "escalated" },
    { cust: "cus_06", order: "ord_1006", clause: "R5", decision: "denied" },
    { cust: "cus_07", order: "ord_1001", clause: "R6", decision: null }, // not their order → refuse, no formal decision
    { cust: "cus_08", order: "ord_1008", clause: "R8", decision: "escalated" },
    { cust: "cus_09", order: "ord_1009", clause: "R7", decision: "approved" },
    { cust: "cus_10", order: "ord_1010", clause: "R7", decision: "approved" },
    { cust: "cus_11", order: "ord_1011", clause: "R9", decision: "approved" },
    { cust: "cus_12", order: "ord_1012", clause: "R1", decision: "denied" },
    { cust: "cus_13", order: "ord_1013", clause: "R4", decision: "escalated" },
    { cust: "cus_14", order: "ord_9999", clause: "R6", decision: null }, // unknown order → verify, no decision
    { cust: "cus_15", order: "ord_1015", clause: "R1", decision: "approved" },
    { cust: "cus_15", order: "ord_1016", clause: "R9", decision: "approved" },
  ];

  for (const f of FLOWS) {
    it(`${f.cust} / ${f.order} → ${f.decision ?? "no decision"}`, async () => {
      const s = createSession({ now: NOW, boundCustomerId: f.cust });
      const steps: CompletionResult[] = [
        step([call("check_refund_eligibility", { customerId: f.cust, orderId: f.order })]),
      ];
      if (f.decision === "approved") {
        steps.push(step([call("process_refund", { customerId: f.cust, orderId: f.order })]));
      } else if (f.decision === "denied") {
        steps.push(
          step([
            call("deny_refund", {
              customerId: f.cust,
              orderId: f.order,
              clauses: [f.clause],
              reason: "Per policy.",
            }),
          ]),
        );
      } else if (f.decision === "escalated") {
        steps.push(
          step([
            call("escalate_to_human", {
              customerId: f.cust,
              orderId: f.order,
              clauses: [f.clause],
              reason: "Per policy.",
            }),
          ]),
        );
      }
      steps.push(finalStep("Here is the outcome of your request."));
      await run(s.id, `Please handle a refund for ${f.order}.`, scriptedCompleter(steps));

      const decisions = eventsOfType(s.id, "decision");
      if (f.decision === null) {
        // A mismatch/unknown order must never yield an approval, and (ownership-guarded) records nothing.
        expect(decisions.filter((d) => d.payload.outcome === "approved")).toHaveLength(0);
      } else {
        expect(
          decisions.some(
            (d) => d.payload.outcome === f.decision && d.payload.clauses.includes(f.clause),
          ),
        ).toBe(true);
      }
    });
  }
});

describe("code-enforced process_refund ordering guard", () => {
  it("blocks process_refund with no prior passing check — even for an approvable order", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    // ord_1001 IS approvable, but the model skipped check_refund_eligibility.
    const completer = scriptedCompleter([
      step([call("process_refund", { customerId: "cus_01", orderId: "ord_1001" })]),
      finalStep("Let me verify that first."),
    ]);
    await run(s.id, "just refund ord_1001 now", completer);

    expect(
      eventsOfType(s.id, "decision").filter((d) => d.payload.outcome === "approved"),
    ).toHaveLength(0);
    expect(getOrder(s.id, "ord_1001")!.order.priorRefund.amount).toBe(0); // no money moved
    expect(eventsOfType(s.id, "error").some((e) => e.payload.where === "agent-guard")).toBe(true);
  });

  it("allows process_refund after a passing check earlier in the SAME conversation (multi-turn)", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    // Turn 1: only check eligibility.
    await run(
      s.id,
      "is ord_1001 refundable?",
      scriptedCompleter([
        step([call("check_refund_eligibility", { customerId: "cus_01", orderId: "ord_1001" })]),
        finalStep("Yes — eligible for a full refund under R1. Shall I process it?"),
      ]),
    );
    // Turn 2: process (the check happened last turn).
    await run(
      s.id,
      "yes please",
      scriptedCompleter([
        step([call("process_refund", { customerId: "cus_01", orderId: "ord_1001" })]),
        finalStep("Done — $129.00 refunded."),
      ]),
    );
    expect(getOrder(s.id, "ord_1001")!.order.priorRefund.refunded).toBe(true);
    expect(eventsOfType(s.id, "decision").some((d) => d.payload.outcome === "approved")).toBe(true);
  });
});

describe("resilience: retries, network kill, tool failure, bail-out", () => {
  it("retries with backoff on API failure (emits retry events) then succeeds", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    let calls = 0;
    const completer: ChatCompleter = async () => {
      calls += 1;
      if (calls <= 2) throw new Error("network blip");
      return finalStep("Hi! How can I help with your refund?");
    };
    const { reply } = await run(s.id, "hi", completer, { maxRetries: 3 });
    expect(reply).toContain("How can I help");
    expect(eventsOfType(s.id, "retry")).toHaveLength(2);
    expect(calls).toBe(3);
  });

  it("degrades gracefully when every attempt fails (network kill)", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    const completer: ChatCompleter = async () => {
      throw new Error("connection refused");
    };
    const { reply } = await run(s.id, "hi", completer, { maxRetries: 3 });
    expect(reply).toMatch(/trouble connecting/i);
    expect(eventsOfType(s.id, "retry")).toHaveLength(3);
    expect(eventsOfType(s.id, "error").some((e) => e.payload.where === "runAgent")).toBe(true);
  });

  it("records a tool failure and continues to a coherent reply", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    const completer = scriptedCompleter([
      step([call("get_order_details", { orderId: 123 })]), // wrong type → invalid input
      finalStep("Could you share your order id?"),
    ]);
    const { reply } = await run(s.id, "refund", completer);
    expect(reply).toContain("order id");
    expect(
      eventsOfType(s.id, "tool_result").some(
        (e) => e.payload.tool === "get_order_details" && e.payload.ok === false,
      ),
    ).toBe(true);
  });

  it("bails out cleanly after the iteration limit", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    const completer: ChatCompleter = async () =>
      step([call("lookup_customer", { customerId: "cus_01" })]); // never finalizes
    const { reply } = await run(s.id, "loop", completer, { maxIterations: 4 });
    expect(reply).toMatch(/human specialist/i);
    expect(
      eventsOfType(s.id, "error").some((e) => e.payload.message.includes("iteration limit")),
    ).toBe(true);
    expect(
      eventsOfType(s.id, "tool_call").filter((e) => e.payload.tool === "lookup_customer"),
    ).toHaveLength(4);
  });
});

describe("conversation events", () => {
  it("emits user_message and a final assistant_message", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    await run(s.id, "hello", scriptedCompleter([finalStep("Hi there!")]));
    expect(eventsOfType(s.id, "user_message")[0].payload.text).toBe("hello");
    expect(eventsOfType(s.id, "assistant_message").at(-1)?.payload.text).toBe("Hi there!");
  });

  it("returns a friendly message for an unknown session (no throw)", async () => {
    const { reply } = await runAgent("sess_missing", "hi", {
      completer: scriptedCompleter([finalStep("x")]),
      baseDelayMs: 0,
    });
    expect(reply).toMatch(/session has expired/i);
  });

  it("degrades gracefully (no throw) when the default completer can't be created", async () => {
    const s = createSession({ now: NOW, boundCustomerId: "cus_01" });
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY; // forces getDefaultCompleter -> requireOpenAIKey to throw
    try {
      const { reply } = await runAgent(s.id, "hi", { baseDelayMs: 0 }); // no completer override
      expect(typeof reply).toBe("string");
      expect(reply.length).toBeGreaterThan(0);
      expect(eventsOfType(s.id, "error").some((e) => e.payload.where === "runAgent")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
