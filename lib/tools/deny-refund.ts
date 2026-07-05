import { z } from "zod";
import { getCustomer, getOrder } from "@/lib/db";
import type { DecisionPayload } from "@/lib/events";
import { evaluateEligibility } from "@/lib/tools/check-refund-eligibility";
import { ClauseSchema, defineTool } from "@/lib/tools/types";

const inputSchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().min(1),
  // A denial MUST cite at least one policy clause (Step 3 requirement).
  clauses: z.array(ClauseSchema).min(1),
  reason: z.string().min(1),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  recorded: z.boolean(),
  refusedReason: z.string().optional(),
  customerId: z.string(),
  orderId: z.string(),
  clauses: z.array(z.string()),
  reason: z.string(),
});
type Output = z.infer<typeof outputSchema>;

export const denyRefundTool = defineTool<Input, Output>({
  name: "deny_refund",
  description:
    'Record a refund denial for an order the customer owns. Requires at least one cited policy clause (e.g. ["R1"]) and a short reason. The cited clauses and the recorded reason are taken from the deterministic policy engine for that order, not from your input. Refuses to record a denial for an unknown order or an order that belongs to a different customer.',
  inputSchema,
  outputSchema,
  run: (ctx, input) => {
    const base = {
      customerId: input.customerId,
      orderId: input.orderId,
      clauses: input.clauses,
      reason: input.reason,
    };
    // Ownership cross-check (on RESOLVED ids): a decision must never be misattributed to a non-owned order.
    const found = getOrder(ctx.sessionId, input.orderId);
    if (!found) return { recorded: false, refusedReason: "order_not_found", ...base };
    const requester = getCustomer(ctx.sessionId, input.customerId);
    if (!requester || found.customer.id !== requester.id) {
      return { recorded: false, refusedReason: "not_owned_by_customer", ...base };
    }
    // Authoritative rationale: the cited clauses + the recorded reason come from the deterministic engine
    // for THIS order — never from the model — so a denial can never cite a clause the policy didn't produce.
    const verdict = evaluateEligibility(ctx, input.customerId, input.orderId);
    return { recorded: true, ...base, clauses: verdict.clauses, reason: verdict.reasoning };
  },
  toDecision: (_input, output): DecisionPayload | null => {
    if (!output.recorded) return null;
    return {
      outcome: "denied",
      clauses: output.clauses,
      orderId: output.orderId,
      customerId: output.customerId,
      summary: output.reason,
    };
  },
});
