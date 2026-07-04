import { getFirehoseHistory, getHistory, subscribe } from "@/lib/event-bus";
import type { ReasoningEvent } from "@/lib/events";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // long-lived dashboard feed

/**
 * GET /api/events?sessionId=... — SSE feed of reasoning events for the admin dashboard.
 * Omit sessionId (or pass `*` / `all=1`) for a firehose across all sessions. On connect it BACKFILLS
 * history (so a dashboard opened mid-conversation sees prior events), then tails new events. The SSE
 * `Last-Event-ID` header is honored on BOTH the single-session and firehose paths, so a reconnecting
 * dashboard resumes after its last-seen event instead of re-streaming the whole (bounded) history.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  const firehose = !sessionId || sessionId === "*" || url.searchParams.get("all") === "1";
  const lastEventId = request.headers.get("last-event-id");

  return sseResponse(request, (ctrl) => {
    const forward = (e: ReasoningEvent) => ctrl.send({ event: e.type, data: e, id: e.id });

    // Subscribe before backfilling. Publishing is synchronous (history push → notify), and this
    // handler runs synchronously through the backfill, so no event is missed or double-sent.
    const unsubscribe = subscribe(firehose ? "*" : sessionId!, forward);

    if (firehose) {
      for (const e of getFirehoseHistory(lastEventId)) forward(e);
    } else {
      const history = getHistory(sessionId!);
      const startIndex = lastEventId ? history.findIndex((e) => e.id === lastEventId) + 1 : 0;
      for (const e of history.slice(startIndex)) forward(e);
    }

    return unsubscribe;
  });
}
