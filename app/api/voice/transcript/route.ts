import { z } from "zod";
import { getSession } from "@/lib/db";
import { emit } from "@/lib/event-bus";
import { badRequest, jsonResponse, notFound } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
});

/**
 * POST /api/voice/transcript — record a finalized voice transcript (either side) onto the reasoning
 * bus, so voice sessions surface on the admin dashboard exactly like text ones: a session appears on
 * its first `user_message`, and both sides show as Customer / Agent-reply events (even in a
 * conversation that makes no tool calls). Purely observability — no data mutation.
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return badRequest("sessionId, role, and text are required.");

  const { sessionId, role, text } = parsed.data;
  if (!getSession(sessionId)) return notFound("Unknown session.");

  emit(role === "user" ? "user_message" : "assistant_message", sessionId, { text });
  return jsonResponse({ ok: true });
}
