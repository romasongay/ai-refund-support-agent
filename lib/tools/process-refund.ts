import { z } from "zod";
import { markOrderRefunded } from "@/lib/db";
import type { DecisionPayload } from "@/lib/events";
import { evaluateEligibility } from "@/lib/tools/check-refund-eligibility";
import { defineTool } from "@/lib/tools/types";

const inputSchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().min(1),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  processed: z.boolean(),
  outcome: z.enum(["approve", "approve_partial", "refused"]),
  refundAmount: z.number().nullable(),
  clauses: z.array(z.string()),
  newTotalRefunded: z.number().optional(),
  reason: z.string(),
  customerId: z.string(),
  orderId: z.string(),
});
type Output = z.infer<typeof outputSchema>;

export const processRefundTool = defineTool<Input, Output>({
  name: "process_refund",
  description:
    "Process (issue) a refund for an order. This tool RE-CHECKS eligibility itself and will REFUSE to process anything the policy does not approve — it cannot be used to override the policy or issue a second refund on an order. On success it records the refund and returns the exact amount and cited clauses.",
  inputSchema,
  outputSchema,
  run: (ctx, input) => {
    // Code-enforced guard: recompute the verdict here so process_refund can NEVER pay out
    // something the policy declines/escalates, regardless of what the caller claims.
    const v = evaluateEligibility(ctx, input.customerId, input.orderId);
    const base = { customerId: input.customerId, orderId: input.orderId };

    if (
      (v.outcome === "approve" || v.outcome === "approve_partial") &&
      v.refundAmount !== null &&
      v.refundAmount > 0
    ) {
      const res = markOrderRefunded(ctx.sessionId, input.orderId, v.refundAmount);
      if (!res.ok) {
        return {
          processed: false,
          outcome: "refused",
          refundAmount: null,
          clauses: v.clauses,
          reason: `Refund could not be recorded (${res.reason}).`,
          ...base,
        };
      }
      return {
        processed: true,
        outcome: v.outcome,
        refundAmount: v.refundAmount,
        clauses: v.clauses,
        newTotalRefunded: res.totalRefunded,
        reason: v.reasoning,
        ...base,
      };
    }

    return {
      processed: false,
      outcome: "refused",
      refundAmount: null,
      clauses: v.clauses,
      reason: `Refund refused: the policy verdict for this order is "${v.outcome}". ${v.reasoning}`,
      ...base,
    };
  },
  toDecision: (_input, output): DecisionPayload | null => {
    if (!output.processed) return null;
    return {
      outcome: "approved",
      clauses: output.clauses,
      amount: output.refundAmount,
      orderId: output.orderId,
      customerId: output.customerId,
      summary: output.reason,
    };
  },
});
