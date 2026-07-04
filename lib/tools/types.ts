/** Shared types for the tools layer. Tools are pure, LLM-free functions over the data layer. */
import { z } from "zod";
import type { DecisionPayload } from "@/lib/events";

/** Per-execution context. `now` is the session's frozen clock, so window math is deterministic. */
export interface ToolContext {
  sessionId: string;
  now: Date;
}

export const RefundOutcomeSchema = z.enum([
  "approve",
  "approve_partial",
  "decline",
  "escalate",
  "verify",
]);
export type RefundOutcome = z.infer<typeof RefundOutcomeSchema>;

/** A policy clause citation, e.g. "R1".."R9". */
export const ClauseSchema = z.string().regex(/^R[1-9]$/);

/**
 * The structured verdict returned by `check_refund_eligibility`. `clauses` is `.min(1)`, which
 * STRUCTURALLY guarantees the tool can never return a verdict — approval or otherwise — without a
 * policy-clause citation (a Step 3 adversarial requirement).
 */
export const EligibilityVerdictSchema = z.object({
  outcome: RefundOutcomeSchema,
  clauses: z.array(ClauseSchema).min(1),
  refundAmount: z.number().min(0).nullable(),
  reasoning: z.string().min(1),
  eligibleItems: z.array(z.string()).default([]),
});
export type EligibilityVerdict = z.infer<typeof EligibilityVerdictSchema>;

/** A tool definition: Zod-validated I/O + a pure `run`, plus an optional terminal-decision mapper. */
export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  run(ctx: ToolContext, input: I): O;
  /** For terminal tools: derive the `decision` event payload from a successful result. */
  toDecision?(input: I, output: O): DecisionPayload | null;
}

/** Erase a tool's specific I/O types for storage in the registry (checked at definition site). */
export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef {
  return def as unknown as ToolDef;
}

export type ToolExecutionResult =
  { ok: true; tool: string; result: unknown } | { ok: false; tool: string; error: string };
