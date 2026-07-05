import { z } from "zod";
import { hasOpenAIKey } from "@/lib/config";
import { getSession } from "@/lib/db";
import { badRequest, jsonResponse, notFound } from "@/lib/http";
import { createVoiceToken } from "@/lib/voice/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ sessionId: z.string().min(1) });

/**
 * POST /api/voice/token — mint a short-lived Realtime ephemeral client secret (`ek_…`) for a customer
 * session so the browser can open a WebRTC voice call WITHOUT ever seeing the server API key. The
 * session config (system prompt + tool schemas) is applied server-side. Returns only browser-safe
 * fields. 404 for an unknown session; 503 (graceful) when no key is configured.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasOpenAIKey()) {
    return jsonResponse(
      { error: "Voice is unavailable: OPENAI_API_KEY is not configured on the server." },
      503,
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return badRequest("A sessionId is required.");

  const session = getSession(parsed.data.sessionId);
  if (!session) return notFound("Unknown session.");

  try {
    const token = await createVoiceToken(session);
    return jsonResponse(token);
  } catch (err) {
    // Never leak the key or a raw stack to the client; log server-side for diagnosis.
    console.error("voice token creation failed:", err);
    return jsonResponse({ error: "Could not start a voice session. Please try again." }, 502);
  }
}
