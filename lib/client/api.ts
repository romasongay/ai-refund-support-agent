import { SseParser } from "@/lib/client/sse";
import type { ReasoningEvent } from "@/lib/events";

export interface Profile {
  id: string;
  name: string;
  email: string;
  orderCount: number;
}

export interface SessionInfo {
  sessionId: string;
  customer: { id: string; name: string; email: string } | null;
  /** A real order id for the bound customer, for a per-profile empty-state hint (null if none). */
  sampleOrderId?: string | null;
}

export async function listProfiles(): Promise<Profile[]> {
  const res = await fetch("/api/session");
  if (!res.ok) throw new Error("Failed to load profiles.");
  const body = (await res.json()) as { customers: Profile[] };
  return body.customers;
}

export async function createSession(customerId?: string): Promise<SessionInfo> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(customerId ? { customerId } : {}),
  });
  if (!res.ok) throw new Error("Failed to create session.");
  return (await res.json()) as SessionInfo;
}

export async function resetData(sessionId?: string): Promise<void> {
  await fetch("/api/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });
}

export interface ChatHandlers {
  onEvent?: (event: ReasoningEvent) => void;
  onDone?: (reply: string) => void;
  onError?: (message: string) => void;
}

/** POST a chat message and dispatch the streamed reasoning events + final reply to handlers. */
export async function streamChat(
  sessionId: string,
  message: string,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
      signal,
    });
  } catch {
    if (!signal?.aborted) handlers.onError?.("Couldn't reach the server. Please try again.");
    return;
  }

  if (!res.ok) {
    if (res.status === 409) handlers.onError?.("Please wait for the current reply to finish.");
    else if (res.status === 404)
      handlers.onError?.("Your session expired — please pick a profile again.");
    else handlers.onError?.("Something went wrong. Please try again.");
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    handlers.onError?.("Streaming isn't supported in this browser.");
    return;
  }

  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
        if (frame.event === "done") {
          handlers.onDone?.((frame.data as { reply?: string } | undefined)?.reply ?? "");
        } else if (frame.event && frame.data && typeof frame.data === "object") {
          handlers.onEvent?.(frame.data as ReasoningEvent);
        }
      }
    }
  } catch {
    if (!signal?.aborted) handlers.onError?.("The connection was interrupted. Please try again.");
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
