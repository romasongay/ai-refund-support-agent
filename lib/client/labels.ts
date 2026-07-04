/** Customer-facing labels + styling for tool activity and decisions (pure, client-safe). */

const TOOL_LABELS: Record<string, string> = {
  lookup_customer: "Looking up your account…",
  get_order_details: "Checking your order…",
  check_refund_eligibility: "Reviewing the refund policy…",
  process_refund: "Processing your refund…",
  deny_refund: "Reviewing your request…",
  escalate_to_human: "Escalating to a specialist…",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? "Working on it…";
}

export type DecisionOutcome = "approved" | "denied" | "escalated";

export interface DecisionStyle {
  label: string;
  icon: string;
  banner: string; // Tailwind classes for the banner container
  chip: string; // Tailwind classes for a small chip
}

const DECISION_STYLES: Record<DecisionOutcome, DecisionStyle> = {
  approved: {
    label: "Refund approved",
    icon: "✓",
    banner:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200",
    chip: "bg-emerald-600 text-white",
  },
  denied: {
    label: "Refund denied",
    icon: "✕",
    banner:
      "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-200",
    chip: "bg-rose-600 text-white",
  },
  escalated: {
    label: "Escalated to a specialist",
    icon: "↑",
    banner:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200",
    chip: "bg-amber-500 text-white",
  },
};

export function decisionStyle(outcome: DecisionOutcome): DecisionStyle {
  return DECISION_STYLES[outcome];
}
