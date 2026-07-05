"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionBanner } from "@/components/chat/decision-banner";
import { MessageBubble, type ChatMessage } from "@/components/chat/message-bubble";
import { ProfileSelector } from "@/components/chat/profile-selector";
import { VoiceMic } from "@/components/voice/voice-mic";
import {
  createSession,
  listProfiles,
  resetData,
  streamChat,
  type Profile,
  type SessionInfo,
} from "@/lib/client/api";
import { toolLabel } from "@/lib/client/labels";
import type { DecisionPayload } from "@/lib/events";

const MAX_MESSAGE_CHARS = 8000;

let msgCounter = 0;
const nextId = () => `m${msgCounter++}`;

const secondaryBtn =
  "rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800";

export function CustomerChat() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [decision, setDecision] = useState<DecisionPayload | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const lastUserMessageRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProfiles()
      .then((p) => !cancelled && setProfiles(p))
      .catch(() => !cancelled && setError("Couldn't load customer profiles."));
    const abort = abortRef;
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, activity, decision, error]);

  const selectProfile = useCallback(async (customerId: string) => {
    setCreating(true);
    setError(null);
    try {
      const info = await createSession(customerId);
      setSession(info);
      setMessages([]);
      setDecision(null);
    } catch {
      setError("Couldn't start a session. Please try again.");
    } finally {
      setCreating(false);
    }
  }, []);

  const runTurn = useCallback((sessionId: string, text: string) => {
    setStreaming(true);
    setActivity("Thinking…");
    setError(null);
    lastUserMessageRef.current = text;
    const ac = new AbortController();
    abortRef.current = ac;
    void streamChat(
      sessionId,
      text,
      {
        onEvent: (e) => {
          if (e.type === "tool_call") setActivity(toolLabel(e.payload.tool));
          else if (e.type === "retry") setActivity("Reconnecting…");
          else if (e.type === "decision") setDecision(e.payload);
        },
        onDone: (reply) => {
          if (reply.trim()) {
            setMessages((m) => [...m, { id: nextId(), role: "assistant", text: reply }]);
          }
          setStreaming(false);
          setActivity(null);
        },
        onError: (msg) => {
          setError(msg);
          setStreaming(false);
          setActivity(null);
        },
      },
      ac.signal,
    );
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!session || streaming || !text) return;
    setMessages((m) => [...m, { id: nextId(), role: "user", text }]);
    setInput("");
    setDecision(null);
    runTurn(session.sessionId, text);
  }, [input, session, streaming, runTurn]);

  const retry = useCallback(() => {
    if (!session || streaming || !lastUserMessageRef.current) return;
    setError(null);
    runTurn(session.sessionId, lastUserMessageRef.current);
  }, [session, streaming, runTurn]);

  // Voice transcripts (both sides) flow into the same chat log as spoken messages.
  const addTranscript = useCallback((role: "user" | "assistant", text: string) => {
    setMessages((m) => [...m, { id: nextId(), role, text, spoken: true }]);
  }, []);

  const resetConversation = useCallback(async () => {
    if (!session) return;
    abortRef.current?.abort();
    setStreaming(false);
    setActivity(null);
    setMessages([]);
    setDecision(null);
    setError(null);
    await resetData(session.sessionId);
  }, [session]);

  const switchProfile = useCallback(() => {
    abortRef.current?.abort();
    setSession(null);
    setMessages([]);
    setDecision(null);
    setActivity(null);
    setStreaming(false);
    setError(null);
    setInput("");
  }, []);

  if (!session) {
    return <ProfileSelector profiles={profiles} onSelect={selectProfile} busy={creating} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{session.customer?.name ?? "Guest"}</p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {session.customer?.email ?? "not identified"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetConversation}
            disabled={streaming}
            className={secondaryBtn}
          >
            Reset
          </button>
          <button type="button" onClick={switchProfile} className={secondaryBtn}>
            Switch
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto py-4">
        {messages.length === 0 && (
          <div className="m-auto max-w-sm text-center text-sm text-zinc-500 dark:text-zinc-400">
            <p className="mb-2">Ask about a refund on one of your orders.</p>
            {session.sampleOrderId && (
              <button
                type="button"
                onClick={() =>
                  setInput(`Hi, I'd like a refund for my order ${session.sampleOrderId}.`)
                }
                className="rounded-full border border-zinc-200 px-3 py-1 text-xs transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
              >
                Try: “refund my order {session.sampleOrderId}”
              </button>
            )}
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {decision && <DecisionBanner decision={decision} />}
        {streaming && activity && <ActivityIndicator label={activity} />}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-2 flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={retry}
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="opacity-60"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex justify-center border-t border-zinc-200 pt-3 pb-1 dark:border-zinc-800">
        <VoiceMic sessionId={session.sessionId} disabled={streaming} onTranscript={addTranscript} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex items-end gap-2 pt-2"
      >
        <textarea
          aria-label="Message to the refund agent"
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={streaming ? "Waiting for the agent…" : "Type your message…"}
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
          disabled={streaming}
          className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-indigo-950"
        />
        <button
          type="submit"
          disabled={streaming || input.trim().length === 0}
          className="h-[2.75rem] shrink-0 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function ActivityIndicator({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-1 text-sm text-zinc-500 dark:text-zinc-400"
    >
      <span aria-hidden className="flex gap-1">
        <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
      </span>
      <span>{label}</span>
    </div>
  );
}
