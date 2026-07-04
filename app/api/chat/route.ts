import { z } from "zod";
import { runAgent } from "@/lib/agent";
import { getSession } from "@/lib/db";
import { subscribe } from "@/lib/event-bus";
import type { ReasoningEvent } from "@/lib/events";
import { badRequest, conflict, notFound } from "@/lib/http";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(8000),
});

/** Sessions with a chat turn currently in flight — prevents concurrent turns corrupting one convo. */
const inFlight = new Set<string>();

/**
 * POST /api/chat — accepts { sessionId, message }, runs one agent turn, and streams the reasoning
 * events for that turn over SSE, ending with an `event: done` frame carrying the final reply.
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest(
      "Invalid request body: expected { sessionId, message } (message 1–8000 chars).",
    );
  }

  const { sessionId, message } = parsed.data;
  if (!getSession(sessionId)) return notFound("Unknown session. Please start a new chat.");
  if (inFlight.has(sessionId)) {
    return conflict("A message is already being processed for this session.");
  }

  return sseResponse(request, (ctrl) => {
    // Add INSIDE onStart so it always pairs with the guaranteed `.finally` delete below. If the
    // client already disconnected before the stream started, sseResponse tears down without calling
    // onStart — so we never add, and the session can't get wedged at 409 forever.
    inFlight.add(sessionId);
    let finished = false;
    const finishOnce = (reply: string) => {
      if (finished) return;
      finished = true;
      ctrl.send({ event: "done", data: { reply } });
    };

    const forward = (e: ReasoningEvent) => ctrl.send({ event: e.type, data: e, id: e.id });
    const unsubscribe = subscribe(sessionId, forward);

    runAgent(sessionId, message)
      .then(({ reply }) => finishOnce(reply))
      .catch(() => finishOnce("Sorry, something went wrong handling your request."))
      .finally(() => {
        inFlight.delete(sessionId);
        ctrl.close(); // idempotent; also unsubscribes via teardown
      });

    return unsubscribe;
  });
}
