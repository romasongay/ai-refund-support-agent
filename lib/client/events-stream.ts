import type { EventType, ReasoningEvent } from "@/lib/events";

/** Client-safe list of event types (importing the value from lib/events would pull in node:crypto). */
export const EVENT_TYPES: readonly EventType[] = [
  "user_message",
  "assistant_message",
  "thought",
  "tool_call",
  "tool_result",
  "decision",
  "error",
  "retry",
];

export type StreamStatus = "connecting" | "open" | "reconnecting";

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

/**
 * Runtime envelope guard: accept only frames with a well-formed base (`id`/`sessionId`/`ts`/known
 * `type`) and a non-null object `payload`. It validates the envelope, NOT the per-type payload fields
 * (full Zod re-validation would pull `node:crypto` into the client bundle) — server-side `publish`
 * already Zod-validates every payload. Per-type payload rendering is additionally defended by the
 * per-row ErrorBoundary, and the outcome-summary memos guard the one field they read (`outcome`).
 */
export function isReasoningEvent(value: unknown): value is ReasoningEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.sessionId === "string" &&
    typeof e.ts === "number" &&
    typeof e.type === "string" &&
    EVENT_TYPE_SET.has(e.type) &&
    typeof e.payload === "object" &&
    e.payload !== null
  );
}

/**
 * Subscribe to the reasoning-event feed via EventSource (native auto-reconnect + Last-Event-ID). Omit
 * `sessionId` for the firehose across all sessions. The server backfills history on connect, so a
 * dashboard opened mid-conversation sees prior events. Returns a close function.
 */
export function openEventStream(
  onEvent: (event: ReasoningEvent) => void,
  onStatus: (status: StreamStatus) => void,
  sessionId?: string,
): () => void {
  const url = sessionId ? `/api/events?sessionId=${encodeURIComponent(sessionId)}` : "/api/events";
  const es = new EventSource(url);
  es.onopen = () => onStatus("open");
  es.onerror = () => onStatus("reconnecting");
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (ev) => {
      try {
        const parsed: unknown = JSON.parse((ev as MessageEvent).data);
        if (isReasoningEvent(parsed)) onEvent(parsed);
      } catch {
        /* ignore a malformed frame rather than break the stream */
      }
    });
  }
  return () => es.close();
}

export const EVENT_META: Record<EventType, { label: string }> = {
  user_message: { label: "Customer" },
  assistant_message: { label: "Agent reply" },
  thought: { label: "Thought" },
  tool_call: { label: "Tool call" },
  tool_result: { label: "Tool result" },
  decision: { label: "Decision" },
  error: { label: "Error" },
  retry: { label: "Retry" },
};
