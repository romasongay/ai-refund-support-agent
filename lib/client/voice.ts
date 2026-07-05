/**
 * Browser-side Realtime voice client (Step 8). Establishes a WebRTC call to the OpenAI Realtime API
 * using a short-lived ephemeral key minted by `/api/voice/token` (the server key is never exposed).
 * Mic audio streams up; the agent's audio streams down and plays; both sides' transcripts surface via
 * `onTranscript`; and every tool call the model makes is executed SERVER-SIDE via `/api/voice/tool`
 * (the same tool layer as text), so voice reasoning events flow to the admin dashboard automatically.
 *
 * All browser-API access is feature-detected and every failure mode (unsupported browser, mic denied,
 * token error, connect error) degrades to a typed `onError` so the UI can fall back to text chat.
 *
 * Lifecycle is driven by an `AbortSignal` the caller holds SYNCHRONOUSLY: aborting it at any point —
 * even mid-connect, before the async startup finishes — tears the session down (stops the mic, closes
 * the peer connection, removes the audio element), so a session-switch/unmount can never leak a hot mic.
 */
import { REALTIME_CALLS_URL } from "@/lib/config";

export type VoiceState =
  "idle" | "requesting-mic" | "connecting" | "listening" | "speaking" | "error";

export type VoiceErrorKind = "unsupported" | "mic-denied" | "token" | "connect" | "unknown";

export interface VoiceTranscript {
  role: "user" | "assistant";
  text: string;
}

export interface VoiceHandlers {
  onState: (state: VoiceState) => void;
  onError: (kind: VoiceErrorKind, message: string) => void;
  onTranscript: (transcript: VoiceTranscript) => void;
}

/** ICE `disconnected` is transient per the WebRTC spec — wait this long for self-recovery before tearing down. */
const ICE_DISCONNECT_GRACE_MS = 5000;

/** True when this browser can run the WebRTC voice pipeline (used to hide/disable the mic gracefully). */
export function isVoiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

const MIC_DENIED_ERRORS = new Set(["NotAllowedError", "SecurityError", "PermissionDeniedError"]);

/**
 * Start a voice session. Progress and failures are reported through `handlers`. Abort `signal` to stop
 * the call at any time (idempotent, safe mid-connect). Resolves when startup finishes or fails.
 */
export async function startVoiceSession(
  sessionId: string,
  handlers: VoiceHandlers,
  signal: AbortSignal,
): Promise<void> {
  if (!isVoiceSupported()) {
    handlers.onError("unsupported", "Voice isn't supported in this browser. Please use text chat.");
    handlers.onState("error");
    return;
  }
  if (signal.aborted) return;

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let micStream: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Idempotent: safe to call repeatedly and it always releases whatever has been acquired so far.
  const cleanup = () => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    try {
      dc?.close();
    } catch {
      /* ignore */
    }
    try {
      pc?.close();
    } catch {
      /* ignore */
    }
    micStream?.getTracks().forEach((t) => t.stop());
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
    }
    dc = null;
    pc = null;
    micStream = null;
    audioEl = null;
  };

  const isClosed = () => signal.aborted;
  // Abort (stop / unmount / session-switch) tears down whatever exists RIGHT NOW; anything acquired
  // after the abort is caught by the post-await `isClosed()` checkpoints below.
  signal.addEventListener("abort", cleanup);

  // Terminal connect-side failure: report it, tear the session down, and move the state machine to
  // "error" (which is what lets the UI reset its active flag + surface the retry affordance).
  const fail = (message: string) => {
    if (isClosed()) return;
    handlers.onError("connect", message);
    cleanup();
    handlers.onState("error");
  };

  try {
    // 1) Mic permission (typed denial path so the UI can guide the user).
    handlers.onState("requesting-mic");
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (isClosed()) return;
      const name = err instanceof DOMException ? err.name : "";
      handlers.onError(
        "mic-denied",
        MIC_DENIED_ERRORS.has(name)
          ? "Microphone access was blocked. Enable it in your browser settings, or use text chat."
          : "Couldn't access a microphone. You can still use text chat.",
      );
      handlers.onState("error");
      cleanup();
      return;
    }
    if (isClosed()) return cleanup();

    // 2) Ephemeral token (server mints it; the API key never reaches the browser).
    handlers.onState("connecting");
    const tokenRes = await fetch("/api/voice/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (isClosed()) return cleanup();
    if (!tokenRes.ok) {
      const body = (await tokenRes.json().catch(() => ({}))) as { error?: string };
      handlers.onError("token", body.error ?? "Couldn't start a voice session. Please try again.");
      handlers.onState("error");
      cleanup();
      return;
    }
    const { value: ephemeralKey } = (await tokenRes.json()) as { value: string };
    if (isClosed()) return cleanup();

    // 3) WebRTC peer connection: play the agent's audio, send the mic, open a data channel for events.
    pc = new RTCPeerConnection();
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    pc.ontrack = (event) => {
      if (audioEl) audioEl.srcObject = event.streams[0];
    };
    micStream.getTracks().forEach((track) => pc!.addTrack(track, micStream!));

    dc = pc.createDataChannel("oai-events");
    dc.onopen = () => {
      if (!isClosed()) handlers.onState("listening");
    };
    dc.onmessage = (event) =>
      handleServerEvent(event.data, sessionId, dc!, handlers, isClosed, fail);

    pc.onconnectionstatechange = () => {
      if (isClosed() || !pc) return;
      const st = pc.connectionState;
      if (st === "connected") {
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          disconnectTimer = null;
        }
        return;
      }
      if (st === "failed") {
        fail("The voice connection dropped. Please try again.");
        return;
      }
      if (st === "disconnected" && !disconnectTimer) {
        // Transient per the WebRTC spec — only tear down if it hasn't recovered after a grace period.
        disconnectTimer = setTimeout(() => {
          disconnectTimer = null;
          if (isClosed() || !pc) return;
          if (pc.connectionState !== "connected")
            fail("The voice connection dropped. Please try again.");
        }, ICE_DISCONNECT_GRACE_MS);
      }
    };

    // 4) SDP offer/answer exchange with OpenAI, authorized by the ephemeral key.
    const offer = await pc.createOffer();
    if (isClosed()) return cleanup();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(REALTIME_CALLS_URL, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
    });
    if (isClosed()) return cleanup();
    if (!sdpRes.ok) {
      // Surface the REAL upstream status + message (a generic "couldn't connect" once cost a whole
      // debugging round — e.g. a 404 model_not_found looks like a network error otherwise).
      const detail = await sdpRes.text().catch(() => "");
      let upstream = "";
      try {
        upstream = (JSON.parse(detail) as { error?: { message?: string } })?.error?.message ?? "";
      } catch {
        upstream = detail.slice(0, 200);
      }
      fail(`Voice couldn't connect (HTTP ${sdpRes.status})${upstream ? `: ${upstream}` : "."}`);
      return;
    }
    const answer = await sdpRes.text();
    if (isClosed()) return cleanup();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (err) {
    if (isClosed()) return cleanup();
    handlers.onError("unknown", err instanceof Error ? err.message : "Voice failed to start.");
    handlers.onState("error");
    cleanup();
  }
}

/** Parse and act on one Realtime server event from the data channel. */
async function handleServerEvent(
  data: unknown,
  sessionId: string,
  dc: RTCDataChannel,
  handlers: VoiceHandlers,
  isClosed: () => boolean,
  fail: (message: string) => void,
): Promise<void> {
  if (typeof data !== "string") return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = typeof msg.type === "string" ? msg.type : "";

  switch (type) {
    // User speech: keep the indicator honest as turns alternate.
    case "input_audio_buffer.speech_started":
      if (!isClosed()) handlers.onState("listening");
      return;
    case "output_audio_buffer.started":
      if (!isClosed()) handlers.onState("speaking");
      return;
    case "output_audio_buffer.stopped":
    case "response.done":
      if (!isClosed()) handlers.onState("listening");
      return;

    // Finalized transcripts: render locally AND mirror to the event bus so voice sessions appear on the
    // admin dashboard (session list + Customer/Agent-reply events) just like text ones.
    case "conversation.item.input_audio_transcription.completed": {
      const text = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
      if (text) {
        handlers.onTranscript({ role: "user", text });
        void postTranscript(sessionId, "user", text);
      }
      return;
    }
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done": {
      const text = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
      if (text) {
        handlers.onTranscript({ role: "assistant", text });
        void postTranscript(sessionId, "assistant", text);
      }
      return;
    }

    // A completed function_call item carries name + call_id + arguments together — the reliable trigger.
    case "response.output_item.done": {
      const item = msg.item as
        { type?: string; name?: string; call_id?: string; arguments?: string } | undefined;
      if (item?.type === "function_call" && item.name && item.call_id) {
        await runVoiceToolCall(
          sessionId,
          item.call_id,
          item.name,
          item.arguments ?? "{}",
          dc,
          isClosed,
        );
      }
      return;
    }

    case "error": {
      // A server-side session error is terminal: tear down and move to the error state (consistent
      // with the ICE "failed" path), so the UI resets and offers a retry.
      const err = msg.error as { message?: string } | undefined;
      fail(err?.message ?? "The voice session hit an error.");
      return;
    }
    default:
      return;
  }
}

/** Mirror a finalized transcript to the reasoning bus (best-effort; never breaks the call). */
async function postTranscript(
  sessionId: string,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  try {
    await fetch("/api/voice/transcript", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, role, text }),
    });
  } catch {
    /* transcript logging is best-effort */
  }
}

/**
 * Execute a voice tool call server-side (shared tool layer → reasoning events → dashboard) and hand the
 * result back to the Realtime session so the model can continue. Failures still return an output item
 * (with an error), so the model recovers gracefully rather than stalling.
 */
async function runVoiceToolCall(
  sessionId: string,
  callId: string,
  name: string,
  argumentsJson: string,
  dc: RTCDataChannel,
  isClosed: () => boolean,
): Promise<void> {
  let output: string;
  try {
    const res = await fetch("/api/voice/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, callId, name, arguments: argumentsJson }),
    });
    const body = (await res.json()) as { output?: string; error?: string };
    output = body.output ?? JSON.stringify({ error: body.error ?? "tool_failed" });
  } catch {
    output = JSON.stringify({ error: "tool_execution_failed" });
  }
  if (isClosed() || dc.readyState !== "open") return;
  dc.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    }),
  );
  dc.send(JSON.stringify({ type: "response.create" }));
}
