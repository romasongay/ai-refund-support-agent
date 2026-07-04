import { z } from "zod";
import { cleanupExpiredSessions, createSession, getCustomer, getPristineCustomers } from "@/lib/db";
import { badRequest, jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — the selectable customer profiles for the "login"/profile selector. */
export async function GET(): Promise<Response> {
  const customers = getPristineCustomers().map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    orderCount: c.orders.length,
  }));
  return jsonResponse({ customers });
}

const BodySchema = z.object({ customerId: z.string().min(1).optional() });

/** POST — create a session, optionally bound to a customer profile. */
export async function POST(request: Request): Promise<Response> {
  cleanupExpiredSessions(); // opportunistic TTL cleanup on new-session creation

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) return badRequest("Invalid request body.");

  try {
    const session = createSession({ boundCustomerId: parsed.data.customerId });
    let customer: { id: string; name: string; email: string } | null = null;
    if (session.boundCustomerId) {
      const c = getCustomer(session.id, session.boundCustomerId);
      if (c) customer = { id: c.id, name: c.name, email: c.email };
    }
    return jsonResponse({ sessionId: session.id, customer });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Could not create session.");
  }
}
