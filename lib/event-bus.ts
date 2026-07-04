/**
 * In-memory reasoning-event bus. Tools and both agents publish through it; the admin dashboard
 * consumes it. It keeps a bounded per-session history so a dashboard opened mid-conversation can
 * BACKFILL (not just tail), and supports per-session and firehose ("*") subscriptions.
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

/** Session ids that have at least one recorded event. */
export function getSessionsWithEvents(): string[] {
  return [...history.keys()];
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
}
