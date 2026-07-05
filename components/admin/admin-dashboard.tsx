"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DevTraceTrigger } from "@/components/admin/dev-trace-trigger";
import { ErrorBoundary } from "@/components/admin/error-boundary";
import { EventRow } from "@/components/admin/event-row";
import {
  EVENT_META,
  EVENT_TYPES,
  openEventStream,
  type StreamStatus,
} from "@/lib/client/events-stream";
import type { EventType, ReasoningEvent } from "@/lib/events";

/** Events rendered per page of a session timeline (keeps 200+ event sessions responsive). "Show older"
 *  pages further back so nothing is ever permanently hidden. */
const PAGE_SIZE = 400;

/** Bound the client-retained firehose store so a long-lived `/admin` tab has bounded memory. */
const MAX_CLIENT_EVENTS = 5000;

type Outcome = "approved" | "denied" | "escalated";
const OUTCOMES: readonly Outcome[] = ["approved", "denied", "escalated"];
const isOutcome = (v: unknown): v is Outcome => OUTCOMES.includes(v as Outcome);

interface SessionSummary {
  id: string;
  count: number;
  lastTs: number;
  lastOutcome: Outcome | null;
}

const OUTCOME_DOT: Record<string, string> = {
  approved: "bg-emerald-500",
  denied: "bg-rose-500",
  escalated: "bg-amber-500",
};

const shortId = (id: string) => (id.startsWith("sess_") ? id.slice(5, 13) : id.slice(0, 8));

export function AdminDashboard() {
  const [events, setEvents] = useState<ReasoningEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<EventType>>(new Set());
  const [paused, setPaused] = useState(false);
  // Pagination window, tagged with the session it applies to so switching sessions resets it to one
  // page WITHOUT a state-sync effect (see effectiveId derivation below).
  const [page, setPage] = useState<{ id: string | null; count: number }>({
    id: null,
    count: PAGE_SIZE,
  });
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const close = openEventStream((event) => {
      if (!event?.id || seenRef.current.has(event.id)) return; // dedupe (backfill/reconnect overlap)
      seenRef.current.add(event.id);
      setEvents((prev) => {
        const next = [...prev, event];
        // Bound client memory: drop the oldest beyond the cap and evict their ids from the dedupe set.
        if (next.length > MAX_CLIENT_EVENTS) {
          const overflow = next.length - MAX_CLIENT_EVENTS;
          for (let i = 0; i < overflow; i++) seenRef.current.delete(next[i].id);
          return next.slice(overflow);
        }
        return next;
      });
    }, setStatus);
    return close;
  }, []);

  const sessions = useMemo<SessionSummary[]>(() => {
    const map = new Map<string, SessionSummary>();
    for (const e of events) {
      const s = map.get(e.sessionId) ?? { id: e.sessionId, count: 0, lastTs: 0, lastOutcome: null };
      s.count += 1;
      s.lastTs = Math.max(s.lastTs, e.ts);
      // Guard the field the envelope check doesn't validate: only trust a known outcome.
      if (e.type === "decision" && isOutcome(e.payload.outcome)) s.lastOutcome = e.payload.outcome;
      map.set(e.sessionId, s);
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
  }, [events]);

  const stats = useMemo(() => {
    const c = { approved: 0, denied: 0, escalated: 0 };
    // Only count known outcomes, so a malformed decision frame can't corrupt the summary totals.
    for (const e of events)
      if (e.type === "decision" && isOutcome(e.payload.outcome)) c[e.payload.outcome] += 1;
    return c;
  }, [events]);

  // Derive the effective selection during render (no state-sync effect): honor a valid explicit
  // selection, otherwise fall back to the most recently active session.
  const effectiveId = useMemo(() => {
    if (selectedId && sessions.some((s) => s.id === selectedId)) return selectedId;
    return sessions[0]?.id ?? null;
  }, [selectedId, sessions]);

  // The window applies only to the session it was expanded for; any other session shows one page.
  const visibleCount = page.id === effectiveId ? page.count : PAGE_SIZE;

  const timeline = useMemo(() => {
    const filtered = events.filter((e) => e.sessionId === effectiveId && !hidden.has(e.type));
    return {
      total: filtered.length,
      shown: filtered.slice(-visibleCount),
      hiddenOlder: Math.max(0, filtered.length - visibleCount),
    };
  }, [events, effectiveId, hidden, visibleCount]);

  // Auto-scroll only when a NEW event lands at the bottom AND the user is already there — never yank
  // the view while reading scrollback, on an unrelated session's event, or when paging older into view
  // (paging changes the shown count but not the newest id, so it must not trigger a jump).
  const lastShownId = timeline.shown.at(-1)?.id;
  useEffect(() => {
    if (paused || !atBottomRef.current) return;
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastShownId, paused]);

  const handleScroll = () => {
    const el = timelineRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // Switching sessions jumps to that session's latest activity (clears the stick-to-bottom intent, so a
  // stale "scrolled up" state from a previous session can't strand it). The page window resets via the
  // render-time derivation above — no state-set here.
  useEffect(() => {
    atBottomRef.current = true;
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [effectiveId]);

  const toggleType = (type: EventType) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  return (
    <div className="flex w-full flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Agent reasoning dashboard</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Live tool calls, decisions, failures &amp; retries across every session.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <DevTraceTrigger />
          <StatChip label="Approved" value={stats.approved} dot="bg-emerald-500" />
          <StatChip label="Denied" value={stats.denied} dot="bg-rose-500" />
          <StatChip label="Escalated" value={stats.escalated} dot="bg-amber-500" />
          <span className="flex items-center gap-1.5 text-zinc-500">
            <span
              className={`h-2 w-2 rounded-full ${status === "open" ? "bg-emerald-500" : status === "reconnecting" ? "bg-amber-500" : "bg-zinc-400"}`}
            />
            {status}
          </span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
        {/* Session list */}
        <aside className="flex max-h-64 min-h-0 flex-col overflow-y-auto rounded-xl border border-zinc-200 md:max-h-none dark:border-zinc-800">
          <div className="border-b border-zinc-200 px-3 py-2 text-xs font-semibold text-zinc-500 dark:border-zinc-800">
            Sessions ({sessions.length})
          </div>
          {sessions.length === 0 ? (
            <p className="p-3 text-xs text-zinc-500">
              No sessions yet. Start a chat on the customer page.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    aria-current={s.id === effectiveId ? "true" : undefined}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                      s.id === effectiveId
                        ? "bg-indigo-50 dark:bg-indigo-950/40"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${s.lastOutcome ? OUTCOME_DOT[s.lastOutcome] : "bg-zinc-300 dark:bg-zinc-600"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono">{shortId(s.id)}</span>
                      <span className="block text-[10px] text-zinc-400">
                        {s.count} event{s.count === 1 ? "" : "s"}
                        {s.lastOutcome ? ` · ${s.lastOutcome}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Timeline */}
        <section className="flex min-h-0 flex-col rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            {EVENT_TYPES.map((type) => {
              const off = hidden.has(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleType(type)}
                  aria-pressed={!off}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    off
                      ? "border-zinc-200 text-zinc-400 line-through dark:border-zinc-800"
                      : "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                  }`}
                >
                  {EVENT_META[type].label}
                </button>
              );
            })}
            <span className="ml-auto text-[11px] text-zinc-400">
              {timeline.hiddenOlder > 0
                ? `${timeline.total} events (showing latest ${timeline.shown.length})`
                : `${timeline.total} events`}
            </span>
          </div>

          <div
            ref={timelineRef}
            onScroll={handleScroll}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            tabIndex={0}
            role="log"
            aria-live="polite"
            aria-label="Agent reasoning event timeline"
            className="flex min-h-64 flex-1 flex-col gap-1.5 overflow-y-auto p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 focus-visible:ring-inset"
          >
            {timeline.hiddenOlder > 0 && (
              <button
                type="button"
                onClick={() => setPage({ id: effectiveId, count: visibleCount + PAGE_SIZE })}
                className="mx-auto mb-1 rounded-full border border-zinc-300 px-3 py-1 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Show {Math.min(PAGE_SIZE, timeline.hiddenOlder)} older
                {timeline.hiddenOlder > PAGE_SIZE ? ` of ${timeline.hiddenOlder}` : ""}
              </button>
            )}
            {timeline.shown.length === 0 ? (
              <p className="m-auto text-xs text-zinc-500">
                {effectiveId ? "No events match the current filters." : "Select a session."}
              </p>
            ) : (
              timeline.shown.map((event) => (
                <ErrorBoundary key={event.id}>
                  <EventRow event={event} />
                </ErrorBoundary>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatChip({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-zinc-800">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="font-medium">{value}</span>
      <span className="text-zinc-500">{label}</span>
    </span>
  );
}
