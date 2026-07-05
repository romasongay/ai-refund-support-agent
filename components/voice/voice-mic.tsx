"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isVoiceSupported, startVoiceSession, type VoiceState } from "@/lib/client/voice";

/** Static store: voice support is fixed per environment. SSR/hydration assumes supported (no "unsupported"
 *  flash for the common case); the client snapshot corrects genuinely-unsupported browsers post-hydration. */
const noopSubscribe = () => () => {};

interface VoiceMicProps {
  sessionId: string;
  disabled?: boolean;
  onTranscript: (role: "user" | "assistant", text: string) => void;
}

const ACTIVE: VoiceState[] = ["requesting-mic", "connecting", "listening", "speaking"];

/** Push-to-connect microphone control. Toggles a live Realtime voice call and streams both sides'
 *  transcripts into the chat log. Degrades gracefully when voice is unsupported or the mic is blocked. */
export function VoiceMic({ sessionId, disabled, onTranscript }: VoiceMicProps) {
  const supported = useSyncExternalStore(
    noopSubscribe,
    () => isVoiceSupported(),
    () => true,
  );
  const [state, setState] = useState<VoiceState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // The AbortController is held SYNCHRONOUSLY so stop()/unmount can cancel even mid-connect (before
  // startVoiceSession resolves); `activeRef` is the synchronous "a session is live" guard (never races
  // with the post-await error callback, so the retry affordance always works).
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(false);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    activeRef.current = false;
    setState("idle");
  }, []);

  // Always tear the call down (aborting even an in-flight connect) on unmount or session change.
  useEffect(() => stop, [stop, sessionId]);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    activeRef.current = true;
    setErrorMsg(null);
    const ac = new AbortController();
    abortRef.current = ac;
    await startVoiceSession(
      sessionId,
      {
        onState: (s) => {
          setState(s);
          if (s === "error") activeRef.current = false;
        },
        onError: (_kind, message) => setErrorMsg(message),
        onTranscript: ({ role, text }) => onTranscript(role, text),
      },
      ac.signal,
    );
  }, [sessionId, onTranscript]);

  const active = ACTIVE.includes(state);
  const onClick = () => (active ? stop() : void start());

  if (!supported) {
    return (
      <p className="text-center text-xs text-zinc-400">
        🎙 Voice isn’t supported in this browser — please use text chat.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        // Stays clickable while connecting so the user can always cancel an in-flight/hung connect
        // (a click during an active state routes to stop() → abort). Only the parent `disabled`
        // (e.g. text streaming) suppresses it.
        disabled={disabled}
        aria-pressed={active}
        aria-label={active ? "Stop voice conversation" : "Start voice conversation"}
        className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          active
            ? "bg-rose-600 text-white hover:bg-rose-500"
            : "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        }`}
      >
        <MicGlyph
          active={active}
          listening={state === "listening"}
          speaking={state === "speaking"}
        />
        <span>{label(state)}</span>
      </button>
      {errorMsg && (
        <p role="alert" className="max-w-xs text-center text-xs text-rose-600 dark:text-rose-400">
          {errorMsg}
        </p>
      )}
    </div>
  );
}

function label(state: VoiceState): string {
  switch (state) {
    case "requesting-mic":
      return "Requesting mic…";
    case "connecting":
      return "Connecting…";
    case "listening":
      return "Listening — tap to stop";
    case "speaking":
      return "Agent speaking — tap to stop";
    case "error":
      return "Try voice again";
    default:
      return "Talk to the agent";
  }
}

function MicGlyph({
  active,
  listening,
  speaking,
}: {
  active: boolean;
  listening: boolean;
  speaking: boolean;
}) {
  return (
    <span aria-hidden className="relative flex h-2.5 w-2.5">
      {(listening || speaking) && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${speaking ? "bg-amber-300" : "bg-emerald-300"}`}
        />
      )}
      <span
        className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
          active ? (speaking ? "bg-amber-200" : "bg-emerald-200") : "bg-zinc-400"
        }`}
      />
    </span>
  );
}
