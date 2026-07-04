/**
 * `check_refund_eligibility` — the deterministic policy engine. Given a customer + order, it applies
 * `data/refund-policy.md`'s decision precedence (R1–R9) and returns a structured verdict with cited
 * clauses and the refundable amount. LLM-free and exhaustively unit-tested against every profile.
 *
 * The money decision lives HERE, in code — never at the model's discretion.
 */
import { z } from "zod";
import { getCustomer, getOrder, MONEY_EPSILON, type Order, type OrderItem } from "@/lib/db";
import {
  defineTool,
  EligibilityVerdictSchema,
  type EligibilityVerdict,
  type RefundOutcome,
  type ToolContext,
} from "@/lib/tools/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const STANDARD_WINDOW_DAYS = 30;
export const DAMAGE_WINDOW_DAYS = 90;
export const HIGH_VALUE_THRESHOLD = 500;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const distinct = (arr: string[]): string[] => [...new Set(arr)];

/** Whole days between an order's delivery and `now`; null if the order was never delivered. */
function daysSinceDelivery(order: Order, now: Date): number | null {
  if (!order.deliveryDate) return null;
  return Math.floor((now.getTime() - new Date(order.deliveryDate).getTime()) / MS_PER_DAY);
}

interface ItemEval {
  name: string;
  price: number;
  eligible: boolean;
  clause: string;
}

/** Per-item eligibility, mirroring policy step 5 (R7 overrides R1/R2; R7 never applies to digital). */
function evaluateItem(item: OrderItem, deliveredDaysAgo: number | null): ItemEval {
  const damaged = item.condition === "damaged" || item.condition === "defective";
  const withinDamageWindow = deliveredDaysAgo !== null && deliveredDaysAgo <= DAMAGE_WINDOW_DAYS;
  const withinStandardWindow =
    deliveredDaysAgo !== null && deliveredDaysAgo <= STANDARD_WINDOW_DAYS;

  if (!item.digital && damaged && withinDamageWindow) {
    return { name: item.name, price: item.price, eligible: true, clause: "R7" };
  }
  if (item.finalSale) return { name: item.name, price: item.price, eligible: false, clause: "R2" };
  if (item.digital) return { name: item.name, price: item.price, eligible: false, clause: "R3" };
  if (withinStandardWindow) {
    return { name: item.name, price: item.price, eligible: true, clause: "R1" };
  }
  return { name: item.name, price: item.price, eligible: false, clause: "R1" };
}

function verdict(
  outcome: RefundOutcome,
  clauses: string[],
  refundAmount: number | null,
  reasoning: string,
  eligibleItems: string[] = [],
): EligibilityVerdict {
  return { outcome, clauses, refundAmount, reasoning, eligibleItems };
}

/**
 * Evaluate a refund request against the policy. Pure over the session's dataset + frozen clock.
 * Follows the exact decision precedence in `data/refund-policy.md`.
 */
export function evaluateEligibility(
  ctx: ToolContext,
  customerId: string,
  orderId: string,
): EligibilityVerdict {
  const requester = getCustomer(ctx.sessionId, customerId);
  const found = getOrder(ctx.sessionId, orderId);

  // Step 1a — unknown order: ask the customer to verify (R6), do not guess.
  if (!found) {
    return verdict(
      "verify",
      ["R6"],
      null,
      `Order "${orderId}" was not found. Ask the customer to verify their order details (R6).`,
    );
  }

  const { customer: owner, order } = found;

  // Step 1b — ownership: order must belong to the requesting (and known) customer.
  if (!requester || owner.id !== customerId) {
    return verdict(
      "decline",
      ["R6"],
      null,
      `Order "${orderId}" does not belong to customer "${customerId}". Declined for security (R6).`,
    );
  }

  // Step 2 — abuse flag.
  if (requester.abuseFlag) {
    return verdict(
      "escalate",
      ["R8"],
      null,
      `Account "${customerId}" is flagged for refund abuse; escalating for manual review (R8).`,
    );
  }

  // Step 3 — high-value order.
  if (order.price > HIGH_VALUE_THRESHOLD) {
    return verdict(
      "escalate",
      ["R4"],
      null,
      `Order total $${order.price.toFixed(2)} exceeds $${HIGH_VALUE_THRESHOLD}; escalating to human review (R4).`,
    );
  }

  // Step 4 — fully refunded already. Derive from amount vs price (single source of truth); the
  // stored `refunded` boolean is only a cache of this and is kept consistent by a schema refine.
  if (order.priorRefund.amount > 0 && order.priorRefund.amount >= order.price - MONEY_EPSILON) {
    return verdict(
      "decline",
      ["R5"],
      null,
      `Order "${orderId}" has already been fully refunded; one refund per order (R5).`,
    );
  }

  // Step 5 — per-item eligibility.
  const deliveredDaysAgo = daysSinceDelivery(order, ctx.now);
  const evals = order.items.map((it) => evaluateItem(it, deliveredDaysAgo));
  const eligible = evals.filter((e) => e.eligible);
  const ineligible = evals.filter((e) => !e.eligible);
  const eligibleValue = round2(eligible.reduce((sum, e) => sum + e.price, 0));
  const priorAmount = order.priorRefund.amount;

  // Step 6 — aggregate, then subtract prior refunds (evaluate these in order).
  if (eligible.length === 0) {
    const clauses = distinct(ineligible.map((e) => e.clause));
    return verdict(
      "decline",
      clauses,
      null,
      `No items are eligible for a refund (${clauses.join(", ")}).`,
    );
  }

  const refundable = round2(eligibleValue - priorAmount);
  if (refundable <= 0) {
    return verdict(
      "decline",
      ["R5"],
      null,
      `The eligible value ($${eligibleValue.toFixed(2)}) has already been refunded (R5).`,
    );
  }

  const eligibleClauses = distinct(eligible.map((e) => e.clause));
  const eligibleNames = eligible.map((e) => e.name);

  if (ineligible.length === 0 && priorAmount === 0) {
    return verdict(
      "approve",
      eligibleClauses,
      refundable,
      `All items eligible; approve a full refund of $${refundable.toFixed(2)} (${eligibleClauses.join(", ")}).`,
      eligibleNames,
    );
  }

  const clauses = distinct([
    "R9",
    ...eligibleClauses,
    ...ineligible.map((e) => e.clause),
    ...(priorAmount > 0 ? ["R5"] : []),
  ]);
  const priorNote = priorAmount > 0 ? ` (minus $${priorAmount.toFixed(2)} already refunded)` : "";
  return verdict(
    "approve_partial",
    clauses,
    refundable,
    `Approve a partial refund of $${refundable.toFixed(2)} for the eligible item(s)${priorNote} (${clauses.join(", ")}).`,
    eligibleNames,
  );
}

const inputSchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().min(1),
});
type Input = z.infer<typeof inputSchema>;

export const checkRefundEligibilityTool = defineTool<Input, EligibilityVerdict>({
  name: "check_refund_eligibility",
  description:
    "Evaluate an order against the refund policy and return a structured verdict (approve, approve_partial, decline, escalate, or verify) with the cited policy clause numbers and the refundable amount. You MUST call this before processing any refund; never approve a refund without it.",
  inputSchema,
  outputSchema: EligibilityVerdictSchema,
  run: (ctx, input) => evaluateEligibility(ctx, input.customerId, input.orderId),
});
