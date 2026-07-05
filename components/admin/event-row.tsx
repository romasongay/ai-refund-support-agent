"use client";

import type { ReactNode } from "react";
import type { ReasoningEvent } from "@/lib/events";

type Tone = "zinc" | "indigo" | "blue" | "cyan" | "emerald" | "rose" | "amber";

const TONES: Record<Tone, { border: string; bg: string }> = {
  zinc: { border: "border-l-zinc-300 dark:border-l-zinc-700", bg: "" },
  indigo: { border: "border-l-indigo-400 dark:border-l-indigo-700", bg: "" },
  blue: { border: "border-l-blue-400 dark:border-l-blue-700", bg: "" },
  cyan: { border: "border-l-cyan-400 dark:border-l-cyan-700", bg: "" },
  emerald: {
    border: "border-l-emerald-500",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
  },
  rose: { border: "border-l-rose-500", bg: "bg-rose-50 dark:bg-rose-950/30" },
  amber: { border: "border-l-amber-500", bg: "bg-amber-50 dark:bg-amber-950/30" },
};

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-zinc-500 select-none hover:text-zinc-700 dark:hover:text-zinc-300">
        {label}
      </summary>
      <pre className="mt-1 max-h-64 max-w-full overflow-auto rounded bg-black/5 p-2 text-[11px] leading-relaxed dark:bg-white/10">
        {safeStringify(value)}
      </pre>
    </details>
  );
}

function Row({
  tone,
  title,
  time,
  prominent,
  children,
}: {
  tone: Tone;
  title: ReactNode;
  time: string;
  prominent?: boolean;
  children?: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div
      className={`rounded-r-md border-l-4 py-1.5 pr-2 pl-3 ${t.border} ${prominent ? t.bg : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-xs ${prominent ? "font-semibold" : "font-medium"}`}>{title}</span>
        <span className="shrink-0 font-mono text-[10px] text-zinc-400">{time}</span>
      </div>
      {children}
    </div>
  );
}

function Clauses({ clauses, amount }: { clauses: string[]; amount?: number | null }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {typeof amount === "number" && amount > 0 && (
        <span className="text-xs font-semibold">${amount.toFixed(2)}</span>
      )}
      {clauses.map((c, i) => (
        // Key by index too: clause lists are model-supplied and not guaranteed unique (e.g. ["R1","R1"]),
        // so keying on the string alone would collide and silently drop a citation the spec wants shown.
        <span
          key={`${c}-${i}`}
          className="rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] font-medium dark:bg-white/15"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

/** Renders a single reasoning event distinctly by type. */
export function EventRow({ event }: { event: ReasoningEvent }) {
  const time = fmtTime(event.ts);

  switch (event.type) {
    case "user_message":
      return (
        <Row tone="zinc" time={time} title="Customer">
          <p className="text-xs break-words whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
            {event.payload.text}
          </p>
        </Row>
      );
    case "assistant_message":
      return (
        <Row tone="indigo" time={time} title="Agent reply">
          <p className="text-xs break-words whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">
            {event.payload.text}
          </p>
        </Row>
      );
    case "thought":
      return (
        <Row tone="zinc" time={time} title="Thought">
          <p className="text-xs break-words whitespace-pre-wrap text-zinc-500 italic dark:text-zinc-400">
            {event.payload.text}
          </p>
        </Row>
      );
    case "tool_call":
      return (
        <Row tone="blue" time={time} title={`Tool call · ${event.payload.tool}`}>
          <JsonDetails label="args" value={event.payload.args} />
        </Row>
      );
    case "tool_result": {
      const ok = event.payload.ok;
      return (
        <Row
          tone={ok ? "cyan" : "rose"}
          time={time}
          prominent={!ok}
          title={
            <>
              Tool result · {event.payload.tool}{" "}
              <span className={ok ? "text-emerald-600" : "text-rose-600"}>
                {ok ? "✓" : "✕ failed"}
              </span>
              {typeof event.payload.durationMs === "number" && (
                <span className="text-zinc-400"> · {event.payload.durationMs}ms</span>
              )}
            </>
          }
        >
          {event.payload.error && (
            <p className="text-xs break-words text-rose-600 dark:text-rose-300">
              {event.payload.error}
            </p>
          )}
          {event.payload.result !== undefined && (
            <JsonDetails label="result" value={event.payload.result} />
          )}
        </Row>
      );
    }
    case "decision": {
      // Tint by outcome so denied/escalated rows match their dots + counters (not always green).
      const tone: Tone =
        event.payload.outcome === "approved"
          ? "emerald"
          : event.payload.outcome === "denied"
            ? "rose"
            : "amber";
      return (
        <Row tone={tone} time={time} prominent title={`Decision · ${event.payload.outcome}`}>
          <p className="text-xs break-words text-zinc-700 dark:text-zinc-200">
            {event.payload.summary}
          </p>
          <Clauses clauses={event.payload.clauses} amount={event.payload.amount} />
        </Row>
      );
    }
    case "error":
      return (
        <Row tone="rose" time={time} prominent title="Error">
          <p className="text-xs break-words text-rose-700 dark:text-rose-300">
            {event.payload.message}
            {event.payload.where ? ` (${event.payload.where})` : ""}
          </p>
          {event.payload.detail && <JsonDetails label="detail" value={event.payload.detail} />}
        </Row>
      );
    case "retry":
      return (
        <Row
          tone="amber"
          time={time}
          prominent
          title={`Retry · attempt ${event.payload.attempt}/${event.payload.maxAttempts}`}
        >
          <p className="text-xs break-words text-amber-800 dark:text-amber-300">
            {event.payload.reason}
            {typeof event.payload.delayMs === "number"
              ? ` · backoff ${event.payload.delayMs}ms`
              : ""}
          </p>
        </Row>
      );
    default:
      return null;
  }
}
