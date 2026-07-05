/**
 * In-memory reasoning-event bus. Tools and both agents publish through it; the admin dashboard
 * consumes it. It keeps a bounded per-session history so a dashboard opened mid-conversation can
 * BACKFILL (not just tail), and supports per-session and firehose ("*") subscriptions. The firehose
 * backfill is reconstructed by merging the per-session histories in global publish order, so no
 * single session's history is ever evicted early by another session's volume.
 */
import {
  createEvent,
  ReasoningEventSchema,
  type EventType,
  type PayloadByType,
  type ReasoningEvent,
} from "@/lib/events";

export type EventListener = (event: ReasoningEvent) => void;

/** Cap per-session history so a runaway session can't exhaust memory. */
export const MAX_EVENTS_PER_SESSION = 5000;

const history = new Map<string, ReasoningEvent[]>();
const sessionListeners = new Map<string, Set<EventListener>>();
const firehoseListeners = new Set<EventListener>();

/**
 * Monotonic publish sequence, stamped (non-enumerably, so it never serializes onto the SSE wire) on
 * each stored event. It gives a stable GLOBAL chronological order across sessions for the firehose
 * backfill — which is reconstructed by merging the per-session histories, so a specific session's
 * full history stays backfillable no matter how busy other sessions are (no lossy global cap).
 */
let seqCounter = 0;
const SEQ = Symbol("seq");
const seqOf = (e: ReasoningEvent): number => (e as ReasoningEvent & { [SEQ]?: number })[SEQ] ?? 0;

function notify(listener: EventListener, event: ReasoningEvent): void {
  // A misbehaving subscriber must never break publishing or the agent loop.
  try {
    listener(event);
  } catch {
    /* swallow listener errors */
  }
}

/** Validate, store, and fan out an event. Returns the stored event. */
export function publish(event: ReasoningEvent): ReasoningEvent {
  const parsed = ReasoningEventSchema.parse(event);
  Object.defineProperty(parsed, SEQ, { value: seqCounter++, enumerable: false });
  const list = history.get(parsed.sessionId) ?? [];
  list.push(parsed);
  if (list.length > MAX_EVENTS_PER_SESSION) {
    list.splice(0, list.length - MAX_EVENTS_PER_SESSION);
  }
  history.set(parsed.sessionId, list);

  const subs = sessionListeners.get(parsed.sessionId);
  if (subs) for (const l of subs) notify(l, parsed);
  for (const l of firehoseListeners) notify(l, parsed);
  return parsed;
}

/** Convenience: build + publish an event in one call. */
export function emit<T extends EventType>(
  type: T,
  sessionId: string,
  payload: PayloadByType[T],
  opts?: { id?: string; ts?: number },
): ReasoningEvent {
  return publish(createEvent(type, sessionId, payload, opts));
}

/**
 * Subscribe to a single session's events, or to all sessions with `"*"` (firehose).
 * Returns an unsubscribe function.
 */
export function subscribe(sessionId: string, listener: EventListener): () => void {
  if (sessionId === "*") {
    firehoseListeners.add(listener);
    return () => firehoseListeners.delete(listener);
  }
  const set = sessionListeners.get(sessionId) ?? new Set<EventListener>();
  set.add(listener);
  sessionListeners.set(sessionId, set);
  return () => {
    const s = sessionListeners.get(sessionId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) sessionListeners.delete(sessionId);
  };
}

/** All events recorded for a session (a copy, oldest first). */
export function getHistory(sessionId: string): ReasoningEvent[] {
  return (history.get(sessionId) ?? []).slice();
}

/**
 * True if a `decision` event has already been recorded for this order in the session. Used to
 * guarantee EXACTLY ONE decision per resolved order — whichever terminal tool fires first (the
 * eligibility engine for declines/escalations, or process_refund for approvals) emits it; later
 * tools for the same order are deduped.
 */
export function hasDecisionForOrder(sessionId: string, orderId: string): boolean {
  const list = history.get(sessionId);
  if (!list) return false;
  return list.some(
    (e) => e.type === "decision" && (e.payload as { orderId?: string }).orderId === orderId,
  );
}

/**
 * True if a decision with this outcome already exists for the session. Dedupe fallback for a terminal
 * that carries NO resolvable order key (e.g. an account-level `escalate_to_human` with no orderId),
 * which would otherwise slip past {@link hasDecisionForOrder} and double-emit.
 */
export function hasDecisionOfOutcome(sessionId: string, outcome: string): boolean {
  const list = history.get(sessionId);
  if (!list) return false;
  return list.some(
    (e) => e.type === "decision" && (e.payload as { outcome?: string }).outcome === outcome,
  );
}

/**
 * Firehose backfill: EVERY session's events merged into one global chronological order (by publish
 * sequence). Reconstructed from the per-session histories, so each session's full retained history is
 * always backfillable regardless of cross-session volume. When `afterId` is a known event id (the SSE
 * `Last-Event-ID` on reconnect), only events strictly after it are returned — so a reconnecting
 * `/admin` tab resumes instead of re-streaming everything; an unknown/absent id replays the whole log
 * (the client dedupes by id).
 */
export function getFirehoseHistory(afterId?: string | null): ReasoningEvent[] {
  const merged = [...history.values()].flat().sort((a, b) => seqOf(a) - seqOf(b));
  if (!afterId) return merged;
  const cutoff = merged.find((e) => e.id === afterId);
  if (!cutoff) return merged;
  const cutoffSeq = seqOf(cutoff);
  return merged.filter((e) => seqOf(e) > cutoffSeq);
}

export function clearSessionEvents(sessionId: string): void {
  history.delete(sessionId);
}

/** Clear all recorded history. Active subscriptions are left intact (dashboards stay connected). */
export function clearAllEvents(): void {
  history.clear();
}

/** Full teardown for tests: drop history AND all subscribers. */
export function __resetBusForTests(): void {
  history.clear();
  sessionListeners.clear();
  firehoseListeners.clear();
  seqCounter = 0;
}
