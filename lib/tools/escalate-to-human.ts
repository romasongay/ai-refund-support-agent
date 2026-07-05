import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getCustomer, getOrder } from "@/lib/db";
import type { DecisionPayload } from "@/lib/events";
import { evaluateEligibility } from "@/lib/tools/check-refund-eligibility";
import { ClauseSchema, defineTool } from "@/lib/tools/types";

const inputSchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().min(1).optional(),
  // An escalation is a refund decision and must cite at least one clause (matches deny_refund).
  clauses: z.array(ClauseSchema).min(1),
  reason: z.string().min(1),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  escalated: z.boolean(),
  ticketId: z.string().optional(),
  refusedReason: z.string().optional(),
  customerId: z.string(),
  orderId: z.string().optional(),
  clauses: z.array(z.string()),
  reason: z.string(),
});
type Output = z.infer<typeof outputSchema>;

export const escalateToHumanTool = defineTool<Input, Output>({
  name: "escalate_to_human",
  description:
    "Escalate the request to a human reviewer, creating a ticket. Use this for check_refund_eligibility 'escalate' verdicts (e.g. R4 high-value orders, R8 abuse-flagged accounts) or when the customer disputes a decision and wants human review. Requires at least one cited clause and a reason, BUT the recorded clauses + reason are taken from the deterministic engine for that order (not your input) — you cannot attach a clause or threshold the policy didn't produce. If an orderId is given, it must belong to the customer.",
  inputSchema,
  outputSchema,
  run: (ctx, input) => {
    const base = {
      customerId: input.customerId,
      orderId: input.orderId,
      clauses: input.clauses,
      reason: input.reason,
    };
    const ticket = () => `esc_${randomUUID().slice(0, 8)}`;
    // If an order is referenced and it exists, it must belong to the requesting customer — otherwise
    // refuse, so an escalation can't be misattributed to another customer's order. Compare RESOLVED ids.
    if (input.orderId) {
      const found = getOrder(ctx.sessionId, input.orderId);
      const requester = getCustomer(ctx.sessionId, input.customerId);
      if (found && (!requester || found.customer.id !== requester.id)) {
        return { escalated: false, refusedReason: "not_owned_by_customer", ...base };
      }
      if (found) {
        // Authoritative rationale from the engine — the model cannot invent the escalation clause/threshold
        // (e.g. claiming a final-sale order "exceeds $500 / R4"). Cite the order's REAL clauses; when the
        // engine itself didn't escalate, this is a customer-requested/dispute escalation — say so plainly.
        const verdict = evaluateEligibility(ctx, input.customerId, input.orderId);
        const reason =
          verdict.outcome === "escalate"
            ? verdict.reasoning
            : `Escalated to a human reviewer at the customer's request. The automated policy result for this order was: ${verdict.reasoning}`;
        return { escalated: true, ticketId: ticket(), ...base, clauses: verdict.clauses, reason };
      }
    }
    // No resolvable order — a general/account-level escalation. Relay a canonical customer-request reason
    // rather than a model-authored justification (there is no per-order verdict to cite).
    return {
      escalated: true,
      ticketId: ticket(),
      ...base,
      reason: "Escalated to a human reviewer at the customer's request.",
    };
  },
  toDecision: (_input, output): DecisionPayload | null => {
    if (!output.escalated) return null;
    return {
      outcome: "escalated",
      clauses: output.clauses,
      orderId: output.orderId,
      customerId: output.customerId,
      summary: output.reason,
    };
  },
});
