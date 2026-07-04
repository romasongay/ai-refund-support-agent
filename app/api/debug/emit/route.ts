import { z } from "zod";
import { badRequest, jsonResponse, notFound } from "@/lib/http";
import { emit } from "@/lib/event-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ sessionId: z.string().min(1).optional() });

/**
 * POST /api/debug/emit — DEV/TEST ONLY. Injects a synthetic failure/retry reasoning trace into the
 * event bus for a session so the admin dashboard's error/retry rendering can be verified end-to-end
 * (bus → SSE → EventSource → EventRow) and demoed. It writes only to the in-memory reasoning log — no
 * data mutation, no secrets — and is INERT in production (404), so it cannot be abused on a real deploy.
 * The target sessionId is restricted to a synthetic `sess_debug*` namespace so it can never forge a
 * trace into a real customer session's log (real ids are `sess_<uuid>`).
 */
export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return notFound("Not found.");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) return badRequest("Invalid request body.");

  const sessionId = parsed.data.sessionId ?? "sess_debug_trace";
  if (!sessionId.startsWith("sess_debug")) {
    return badRequest("debug/emit only targets synthetic sess_debug* sessions.");
  }
  const orderId = "ord_9999";

  // A realistic "upstream flaked, we retried, then escalated" trace exercising every prominent type.
  emit("user_message", sessionId, { text: `Please refund my order ${orderId}.` });
  emit("tool_call", sessionId, { tool: "get_order_details", args: { orderId } });
  emit("tool_result", sessionId, {
    tool: "get_order_details",
    ok: false,
    error: "Upstream order service returned 503 (simulated).",
    durationMs: 12,
  });
  emit("retry", sessionId, {
    attempt: 1,
    maxAttempts: 3,
    reason: "OpenAI API error: 503 Service Unavailable (simulated).",
    delayMs: 500,
  });
  emit("retry", sessionId, {
    attempt: 2,
    maxAttempts: 3,
    reason: "OpenAI API error: 503 Service Unavailable (simulated).",
    delayMs: 1000,
  });
  emit("error", sessionId, {
    message: "get_order_details failed after 3 attempts; falling back to human review.",
    where: "agent-loop",
  });
  emit("decision", sessionId, {
    outcome: "escalated",
    clauses: ["R4"],
    summary:
      "Escalated to a human agent after repeated upstream failures prevented a policy check.",
    orderId,
  });

  return jsonResponse({ ok: true, sessionId, emitted: 7 });
}
