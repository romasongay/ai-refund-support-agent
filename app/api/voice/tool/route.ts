import { z } from "zod";
import { getSession } from "@/lib/db";
import { badRequest, jsonResponse, notFound } from "@/lib/http";
import { executeTool } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  sessionId: z.string().min(1),
  callId: z.string().min(1),
  name: z.string().min(1),
  /** The model's tool-call arguments as a JSON string (Realtime sends them stringified). */
  arguments: z.string(),
});

/**
 * POST /api/voice/tool — execute a voice agent's tool call SERVER-SIDE through the shared tool layer.
 * The browser forwards each Realtime `function_call` here; we run it via {@link executeTool} (the same
 * path the text agent uses), which validates I/O and publishes the reasoning events — so voice tool
 * calls appear on the admin dashboard automatically. Returns the tool output as a JSON string for the
 * browser to hand back to the Realtime session. Money decisions stay code-enforced inside the tools.
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return badRequest("sessionId, callId, name, and arguments are required.");

  const { sessionId, callId, name, arguments: argString } = parsed.data;
  if (!getSession(sessionId)) return notFound("Unknown session.");

  let args: unknown;
  try {
    args = argString.trim() ? JSON.parse(argString) : {};
  } catch {
    args = {};
  }

  const exec = await executeTool(sessionId, name, args);
  const output = JSON.stringify(exec.ok ? exec.result : { error: exec.error });
  return jsonResponse({ callId, output });
}
