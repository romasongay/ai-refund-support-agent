import { z } from "zod";
import { resetAgentConversation, resetAllConversations } from "@/lib/agent";
import { resetAllSessions, resetSession } from "@/lib/db";
import { clearAllEvents, clearSessionEvents } from "@/lib/event-bus";
import { badRequest, jsonResponse, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ sessionId: z.string().min(1).optional() });

/**
 * POST — restore pristine mock data. With a `sessionId`, resets just that session (data + events +
 * conversation); with no body, performs a full reset of all sessions, events, and conversations.
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) return badRequest("Invalid request body.");

  const { sessionId } = parsed.data;
  if (sessionId) {
    if (!resetSession(sessionId)) return notFound("Unknown session.");
    clearSessionEvents(sessionId);
    resetAgentConversation(sessionId);
    return jsonResponse({ ok: true, scope: "session" });
  }

  resetAllSessions();
  clearAllEvents();
  resetAllConversations();
  return jsonResponse({ ok: true, scope: "all" });
}
