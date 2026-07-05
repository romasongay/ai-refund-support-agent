/**
 * Server-Sent Events helper for Next 16 route handlers. Builds a `Response` around a
 * `ReadableStream` and guarantees teardown on client disconnect: the abort signal, stream cancel,
 * and explicit close all funnel through a single idempotent `teardown` that clears the heartbeat
 * and runs the caller's cleanup (e.g. bus unsubscribe) — so no handles or listeners are orphaned.
 */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no", // defeat proxy buffering
  "X-Content-Type-Options": "nosniff",
};

export interface SseFrame {
  event?: string;
  data: unknown;
  id?: string;
}

export interface SseController {
  send: (frame: SseFrame) => void;
  comment: (text: string) => void;
  close: () => void;
}

/**
 * `onStart` receives a controller and returns an optional cleanup function (called exactly once on
 * teardown). It runs synchronously when the stream starts.
 */
export function sseResponse(
  request: Request,
  onStart: (ctrl: SseController) => (() => void) | undefined | void,
  opts: { heartbeatMs?: number } = {},
): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = opts.heartbeatMs ?? 15000;

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let userCleanup: (() => void) | undefined;
  let abortHandler: (() => void) | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
    if (userCleanup) {
      try {
        userCleanup();
      } catch {
        /* cleanup must not throw */
      }
    }
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      const enqueue = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* controller closed underneath us */
        }
      };

      const ctrl: SseController = {
        send: (frame) => {
          let s = "";
          if (frame.id) s += `id: ${frame.id}\n`;
          if (frame.event) s += `event: ${frame.event}\n`;
          s += `data: ${JSON.stringify(frame.data)}\n\n`;
          enqueue(s);
        },
        comment: (text) => enqueue(`: ${text}\n\n`),
        close: teardown,
      };

      // If the client already went away before we started, tear down immediately.
      if (request.signal.aborted) {
        teardown();
        return;
      }

      abortHandler = teardown;
      request.signal.addEventListener("abort", abortHandler);
      // Flush an immediate preamble so the response HEAD is sent at once. Without a first byte, the
      // platform delays the response head until the first write — up to `heartbeatMs` when there is
      // ZERO backfill — so EventSource `onopen` (and the dashboard's "open" pill) would stall on a
      // pristine feed. A leading SSE comment is ignored by the client and fixes this deterministically.
      ctrl.comment("connected");
      heartbeat = setInterval(() => ctrl.comment("keep-alive"), heartbeatMs);
      userCleanup = onStart(ctrl) ?? undefined;
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
