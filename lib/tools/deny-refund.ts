import { z } from "zod";
import { getOrder } from "@/lib/db";
import type { DecisionPayload } from "@/lib/events";
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
    'Record a refund denial for an order the customer owns. Requires at least one cited policy clause (e.g. ["R1"]) and a short reason. Refuses to record a denial for an unknown order or an order that belongs to a different customer.',
  inputSchema,
  outputSchema,
  run: (ctx, input) => {
    const base = {
      customerId: input.customerId,
      orderId: input.orderId,
      clauses: input.clauses,
      reason: input.reason,
    };
    // Ownership cross-check: a decision must never be misattributed to a non-owned order.
    const found = getOrder(ctx.sessionId, input.orderId);
    if (!found) return { recorded: false, refusedReason: "order_not_found", ...base };
    if (found.customer.id !== input.customerId) {
      return { recorded: false, refusedReason: "not_owned_by_customer", ...base };
    }
    return { recorded: true, ...base };
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
