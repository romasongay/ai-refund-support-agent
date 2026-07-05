import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, getOrder, resetAllSessions, type Session } from "@/lib/db";
import { __resetBusForTests, getHistory } from "@/lib/event-bus";
import type { ReasoningEvent } from "@/lib/events";
import { evaluateEligibility } from "@/lib/tools/check-refund-eligibility";
import { executeTool, openaiTools, TOOLS } from "@/lib/tools";
import type { ToolContext, ToolExecutionResult } from "@/lib/tools/types";

let session: Session;
beforeEach(() => {
  session = createSession({ now: new Date("2027-06-01T00:00:00.000Z") });
});
afterEach(() => {
  resetAllSessions();
  __resetBusForTests();
});

const ctx = (): ToolContext => ({ sessionId: session.id, now: session.now });

function ok(r: ToolExecutionResult): unknown {
  if (!r.ok) throw new Error(`expected ok result, got error: ${r.error}`);
  return r.result;
}

const eventsOfType = <T extends ReasoningEvent["type"]>(sid: string, type: T) =>
  getHistory(sid).filter((e): e is Extract<ReasoningEvent, { type: T }> => e.type === type);

interface ProcessResult {
  processed: boolean;
  outcome: string;
  refundAmount: number | null;
  clauses: string[];
  reason: string;
}

// The oracle from data/refund-scenarios.md — the tools must reproduce these exactly.
const ORACLE: Array<{
  cust: string;
  order: string;
  outcome: string;
  amount: number | null;
  clause: string;
}> = [
  { cust: "cus_01", order: "ord_1001", outcome: "approve", amount: 129, clause: "R1" },
  { cust: "cus_02", order: "ord_1002", outcome: "decline", amount: null, clause: "R1" },
  { cust: "cus_03", order: "ord_1003", outcome: "decline", amount: null, clause: "R2" },
  { cust: "cus_04", order: "ord_1004", outcome: "decline", amount: null, clause: "R3" },
  { cust: "cus_05", order: "ord_1005", outcome: "escalate", amount: null, clause: "R4" },
  { cust: "cus_06", order: "ord_1006", outcome: "decline", amount: null, clause: "R5" },
  { cust: "cus_07", order: "ord_1001", outcome: "decline", amount: null, clause: "R6" },
  { cust: "cus_08", order: "ord_1008", outcome: "escalate", amount: null, clause: "R8" },
  { cust: "cus_09", order: "ord_1009", outcome: "approve", amount: 60, clause: "R7" },
  { cust: "cus_10", order: "ord_1010", outcome: "approve", amount: 140, clause: "R7" },
  { cust: "cus_11", order: "ord_1011", outcome: "approve_partial", amount: 70, clause: "R9" },
  { cust: "cus_12", order: "ord_1012", outcome: "decline", amount: null, clause: "R1" },
  { cust: "cus_13", order: "ord_1013", outcome: "escalate", amount: null, clause: "R4" },
  { cust: "cus_14", order: "ord_9999", outcome: "verify", amount: null, clause: "R6" },
  { cust: "cus_15", order: "ord_1015", outcome: "approve", amount: 110, clause: "R1" },
  { cust: "cus_15", order: "ord_1016", outcome: "approve_partial", amount: 120, clause: "R9" },
];

describe("check_refund_eligibility — oracle across all 16 requests", () => {
  for (const t of ORACLE) {
    it(`${t.cust} / ${t.order} -> ${t.outcome}`, () => {
      const v = evaluateEligibility(ctx(), t.cust, t.order);
      expect(v.outcome).toBe(t.outcome);
      if (t.amount === null) expect(v.refundAmount).toBeNull();
      else expect(v.refundAmount).toBeCloseTo(t.amount, 2);
      expect(v.clauses).toContain(t.clause);
      expect(v.clauses.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("NEVER returns any verdict (approval or otherwise) without a clause citation", () => {
    for (const t of ORACLE) {
      const v = evaluateEligibility(ctx(), t.cust, t.order);
      expect(v.clauses.length).toBeGreaterThanOrEqual(1);
      if (v.outcome.startsWith("approve")) {
        expect(v.refundAmount).not.toBeNull();
        expect(v.clauses.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("never-refunded ineligible declines do not mis-cite R5", () => {
    for (const [cust, order] of [
      ["cus_02", "ord_1002"],
      ["cus_03", "ord_1003"],
      ["cus_04", "ord_1004"],
      ["cus_12", "ord_1012"],
    ] as const) {
      expect(evaluateEligibility(ctx(), cust, order).clauses).not.toContain("R5");
    }
  });
});

describe("process_refund is policy-guarded (money decision lives in code)", () => {
  it("processes an approvable order once, then refuses the double-refund (R5)", async () => {
    const first = ok(
      await executeTool(session.id, "process_refund", {
        customerId: "cus_01",
        orderId: "ord_1001",
      }),
    ) as ProcessResult;
    expect(first.processed).toBe(true);
    expect(first.refundAmount).toBeCloseTo(129, 2);
    expect(getOrder(session.id, "ord_1001")!.order.priorRefund.refunded).toBe(true);

    const second = ok(
      await executeTool(session.id, "process_refund", {
        customerId: "cus_01",
        orderId: "ord_1001",
      }),
    ) as ProcessResult;
    expect(second.processed).toBe(false);
    expect(second.clauses).toContain("R5");
  });

  it("refuses declines/escalations/mismatch/unknown and moves no money", async () => {
    for (const [cust, order] of [
      ["cus_02", "ord_1002"], // out of window
      ["cus_05", "ord_1005"], // high value → escalate
      ["cus_07", "ord_1001"], // someone else's order → R6
      ["cus_14", "ord_9999"], // unknown order
    ] as const) {
      const r = ok(
        await executeTool(session.id, "process_refund", { customerId: cust, orderId: order }),
      ) as ProcessResult;
      expect(r.processed).toBe(false);
    }
    // Avery's order was targeted by the cus_07 mismatch attempt — it must remain untouched.
    expect(getOrder(session.id, "ord_1001")!.order.priorRefund.amount).toBe(0);
    expect(getOrder(session.id, "ord_1002")!.order.priorRefund.amount).toBe(0);
    expect(getOrder(session.id, "ord_1005")!.order.priorRefund.amount).toBe(0);
  });

  it("pays only the remainder on a partial-prior order, then blocks a re-refund", async () => {
    const r = ok(
      await executeTool(session.id, "process_refund", {
        customerId: "cus_15",
        orderId: "ord_1016",
      }),
    ) as ProcessResult;
    expect(r.processed).toBe(true);
    expect(r.refundAmount).toBeCloseTo(120, 2);
    expect(getOrder(session.id, "ord_1016")!.order.priorRefund.refunded).toBe(true);

    const again = ok(
      await executeTool(session.id, "process_refund", {
        customerId: "cus_15",
        orderId: "ord_1016",
      }),
    ) as ProcessResult;
    expect(again.processed).toBe(false);
  });
});

describe("lookup + order tools across all profiles", () => {
  it("lookup_customer resolves all 15 customers, email (case-insensitive), and junk", async () => {
    for (let i = 1; i <= 15; i++) {
      const id = `cus_${String(i).padStart(2, "0")}`;
      const res = ok(await executeTool(session.id, "lookup_customer", { customerId: id })) as {
        found: boolean;
      };
      expect(res.found).toBe(true);
    }
    const byEmail = ok(
      await executeTool(session.id, "lookup_customer", { email: "AVERY.STONE@Example.com" }),
    ) as { found: boolean; customer?: { id: string } };
    expect(byEmail.customer?.id).toBe("cus_01");

    const junk = ok(await executeTool(session.id, "lookup_customer", { customerId: "cus_ZZ" })) as {
      found: boolean;
    };
    expect(junk.found).toBe(false);

    const neither = await executeTool(session.id, "lookup_customer", {});
    expect(neither.ok).toBe(false); // input validation: must provide id or email
  });

  it("get_order_details resolves all 16 orders, reports ownership, and handles unknown", async () => {
    for (let i = 1001; i <= 1016; i++) {
      const res = ok(
        await executeTool(session.id, "get_order_details", { orderId: `ord_${i}` }),
      ) as { found: boolean };
      expect(res.found).toBe(true);
    }
    const owned = ok(
      await executeTool(session.id, "get_order_details", {
        orderId: "ord_1001",
        customerId: "cus_01",
      }),
    ) as { ownedByRequestingCustomer?: boolean; ownerCustomerId?: string };
    expect(owned.ownedByRequestingCustomer).toBe(true);
    expect(owned.ownerCustomerId).toBe("cus_01");

    const mismatched = ok(
      await executeTool(session.id, "get_order_details", {
        orderId: "ord_1001",
        customerId: "cus_07",
      }),
    ) as { ownedByRequestingCustomer?: boolean };
    expect(mismatched.ownedByRequestingCustomer).toBe(false);

    const missing = ok(
      await executeTool(session.id, "get_order_details", { orderId: "ord_9999" }),
    ) as { found: boolean };
    expect(missing.found).toBe(false);
  });
});

describe("terminal tools require citations, verify ownership, and emit decisions", () => {
  it("deny_refund requires >=1 clause and emits a denied decision for an owned order", async () => {
    const bad = await executeTool(session.id, "deny_refund", {
      customerId: "cus_02",
      orderId: "ord_1002",
      clauses: [],
      reason: "x",
    });
    expect(bad.ok).toBe(false); // empty clauses rejected

    const good = ok(
      await executeTool(session.id, "deny_refund", {
        customerId: "cus_02",
        orderId: "ord_1002",
        clauses: ["R1"],
        reason: "Outside the 30-day window.",
      }),
    ) as { recorded: boolean };
    expect(good.recorded).toBe(true);
    expect(eventsOfType(session.id, "decision").some((e) => e.payload.outcome === "denied")).toBe(
      true,
    );
  });

  it("escalate_to_human requires >=1 clause and emits an escalated decision for an owned order", async () => {
    const bad = await executeTool(session.id, "escalate_to_human", {
      customerId: "cus_05",
      orderId: "ord_1005",
      clauses: [],
      reason: "x",
    });
    expect(bad.ok).toBe(false); // empty clauses rejected (matches deny_refund)

    const r = ok(
      await executeTool(session.id, "escalate_to_human", {
        customerId: "cus_05",
        orderId: "ord_1005",
        clauses: ["R4"],
        reason: "Order over $500.",
      }),
    ) as { escalated: boolean; ticketId?: string };
    expect(r.escalated).toBe(true);
    expect(r.ticketId).toMatch(/^esc_/);
    expect(
      eventsOfType(session.id, "decision").some((e) => e.payload.outcome === "escalated"),
    ).toBe(true);
  });

  it("refuses to record a decision against an order the customer does not own", async () => {
    // cus_07 tries to deny / escalate cus_01's order (ord_1001).
    const deny = ok(
      await executeTool(session.id, "deny_refund", {
        customerId: "cus_07",
        orderId: "ord_1001",
        clauses: ["R2"],
        reason: "bogus",
      }),
    ) as { recorded: boolean; refusedReason?: string };
    expect(deny.recorded).toBe(false);
    expect(deny.refusedReason).toBe("not_owned_by_customer");

    const esc = ok(
      await executeTool(session.id, "escalate_to_human", {
        customerId: "cus_07",
        orderId: "ord_1001",
        clauses: ["R4"],
        reason: "bogus",
      }),
    ) as { escalated: boolean; refusedReason?: string };
    expect(esc.escalated).toBe(false);

    // No misattributed decision reached the audit stream.
    expect(eventsOfType(session.id, "decision")).toHaveLength(0);
  });
});

describe("executor observability + robustness", () => {
  it("emits tool_call + tool_result (and decision only for terminal tools)", async () => {
    await executeTool(session.id, "lookup_customer", { customerId: "cus_01" });
    expect(eventsOfType(session.id, "tool_call")).toHaveLength(1);
    expect(eventsOfType(session.id, "tool_result")).toHaveLength(1);
    expect(eventsOfType(session.id, "decision")).toHaveLength(0);

    await executeTool(session.id, "process_refund", { customerId: "cus_09", orderId: "ord_1009" });
    const decisions = eventsOfType(session.id, "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload).toMatchObject({ outcome: "approved" });
  });

  it("degrades gracefully on unknown tool, unknown/blank session, and bad input (never throws)", async () => {
    expect((await executeTool(session.id, "no_such_tool", {})).ok).toBe(false);
    expect((await executeTool("sess_nope", "lookup_customer", { customerId: "cus_01" })).ok).toBe(
      false,
    );
    expect((await executeTool(session.id, "get_order_details", { orderId: 123 })).ok).toBe(false);
    // Blank sessionId must not throw a ZodError from the event bus — it degrades to ok:false.
    expect((await executeTool("", "lookup_customer", { customerId: "cus_01" })).ok).toBe(false);
    expect(
      (await executeTool("   ", "process_refund", { customerId: "cus_01", orderId: "ord_1001" }))
        .ok,
    ).toBe(false);
  });
});

describe("OpenAI tool export", () => {
  it("exposes 6 tools with clean JSON-schema parameters", () => {
    expect(TOOLS).toHaveLength(6);
    expect(openaiTools).toHaveLength(6);
    expect(openaiTools.map((t) => t.function.name).sort()).toEqual([
      "check_refund_eligibility",
      "deny_refund",
      "escalate_to_human",
      "get_order_details",
      "lookup_customer",
      "process_refund",
    ]);
    for (const t of openaiTools) {
      expect(t.type).toBe("function");
      const params = t.function.parameters as Record<string, unknown>;
      expect(params.type).toBe("object");
      expect(params.$schema).toBeUndefined();
    }
  });
});

describe("spoken / loose identifier resolution flows through the tools (Checkpoint B — voice)", () => {
  it("resolves a spoken order id so eligibility approves (the reported voice bug)", () => {
    // Transcription yields "ORD1001"/"1001"/"order 1001" instead of the stored "ord_1001".
    for (const spoken of ["ORD1001", "ord-1001", "1001", "order 1001"]) {
      const v = evaluateEligibility(ctx(), "cus_01", spoken);
      expect(v.outcome).toBe("approve");
      expect(v.refundAmount).toBe(129);
      expect(v.clauses).toContain("R1");
    }
  });

  it("get_order_details + check_refund_eligibility accept spoken order ids end-to-end", async () => {
    const details = ok(
      await executeTool(session.id, "get_order_details", { orderId: "ORD1001" }),
    ) as { order?: { id?: string } };
    expect(details.order?.id).toBe("ord_1001");

    const verdict = ok(
      await executeTool(session.id, "check_refund_eligibility", {
        customerId: "cus_01",
        orderId: "1,001",
      }),
    ) as { outcome: string };
    expect(verdict.outcome).toBe("approve");
  });

  it("SECURITY: a spoken order id owned by someone else is still declined (R6), not fished", () => {
    // cus_07 (Gray Patel) speaks cus_01's order in a loose form — ownership must still hold.
    const v = evaluateEligibility(ctx(), "cus_07", "1001");
    expect(v.outcome).toBe("decline");
    expect(v.clauses).toContain("R6");
  });

  it("SECURITY: process_refund refuses a spoken cross-customer order (no payout)", async () => {
    const res = ok(
      await executeTool(session.id, "process_refund", { customerId: "cus_07", orderId: "ORD1001" }),
    ) as ProcessResult;
    expect(res.processed).toBe(false);
    expect(res.outcome).toBe("refused");
    // cus_01's order remains un-refunded.
    expect(getOrder(session.id, "ord_1001")!.order.priorRefund.refunded).toBe(false);
  });
});

describe("every resolved request emits exactly one decision event (F1 — code-level, both transports)", () => {
  const decisions = () => eventsOfType(session.id, "decision").map((e) => e.payload);

  it("a decline from check_refund_eligibility emits a denied decision (no deny_refund needed)", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_03",
      orderId: "ord_1003",
    });
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0].outcome).toBe("denied");
    expect(d[0].clauses).toContain("R2");
    expect(d[0].orderId).toBe("ord_1003");
  });

  it("an escalate verdict emits an escalated decision", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_05",
      orderId: "ord_1005",
    });
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0].outcome).toBe("escalated");
    expect(d[0].clauses).toContain("R4");
  });

  it("approve emits NO decision from the eligibility check (process_refund emits the approval)", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_01",
      orderId: "ord_1001",
    });
    expect(decisions()).toHaveLength(0);
  });

  it("dedupes: check(decline) then deny_refund yields exactly one decision", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_03",
      orderId: "ord_1003",
    });
    await executeTool(session.id, "deny_refund", {
      customerId: "cus_03",
      orderId: "ord_1003",
      clauses: ["R2"],
      reason: "final sale",
    });
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0].outcome).toBe("denied");
  });

  it("normalizes a spoken order id in the emitted decision (canonical orderId)", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_03",
      orderId: "ORD1003",
    });
    expect(decisions()[0].orderId).toBe("ord_1003");
  });

  it("a cross-customer spoken order still produces a denied R6 decision (scenario 2½)", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_07",
      orderId: "1001",
    });
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0].outcome).toBe("denied");
    expect(d[0].clauses).toContain("R6");
    expect(d[0].orderId).toBe("ord_1001");
  });
});

describe("decision dedupe survives an order-less / unresolvable escalation (S8-F9)", () => {
  const decisions = () => eventsOfType(session.id, "decision").map((e) => e.payload);

  it("account-level escalate_to_human (no orderId) after an escalate verdict does NOT double-emit", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_08",
      orderId: "ord_1008",
    }); // R8 abuse → escalated{ord_1008}
    await executeTool(session.id, "escalate_to_human", {
      customerId: "cus_08",
      clauses: ["R8"],
      reason: "account flagged for abuse",
    }); // no orderId
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0].outcome).toBe("escalated");
    expect(d[0].orderId).toBe("ord_1008");
  });

  it("an unresolvable order id is dropped (no garbage key) and does not double-emit", async () => {
    await executeTool(session.id, "check_refund_eligibility", {
      customerId: "cus_05",
      orderId: "ord_1005",
    }); // R4 → escalated{ord_1005}
    await executeTool(session.id, "escalate_to_human", {
      customerId: "cus_05",
      orderId: "my order", // unresolvable
      clauses: ["R4"],
      reason: "high value",
    });
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0].orderId).toBe("ord_1005");
  });
});
