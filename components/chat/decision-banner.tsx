"use client";

import { decisionStyle, type DecisionOutcome } from "@/lib/client/labels";
import type { DecisionPayload } from "@/lib/events";

/** Prominent banner shown when the agent resolves a request (approved / denied / escalated). */
export function DecisionBanner({ decision }: { decision: DecisionPayload }) {
  const style = decisionStyle(decision.outcome as DecisionOutcome);
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-4 py-3 text-sm ${style.banner}`}
    >
      <span
        aria-hidden
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${style.chip}`}
      >
        {style.icon}
      </span>
      <span className="font-semibold">{style.label}</span>
      {typeof decision.amount === "number" && decision.amount > 0 && (
        <span className="font-semibold">· ${decision.amount.toFixed(2)}</span>
      )}
      <span className="ml-auto flex flex-wrap gap-1">
        {decision.clauses.map((clause) => (
          <span
            key={clause}
            className="rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium dark:bg-white/10"
          >
            {clause}
          </span>
        ))}
      </span>
    </div>
  );
}
