/** Tiny JSON response helpers for the API routes. */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const badRequest = (error: string): Response => jsonResponse({ error }, 400);
export const notFound = (error: string): Response => jsonResponse({ error }, 404);
export const conflict = (error: string): Response => jsonResponse({ error }, 409);
