"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** True when this message is a transcript from the voice pipeline rather than typed/streamed text. */
  spoken?: boolean;
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] overflow-hidden rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
          isUser
            ? "rounded-br-sm bg-indigo-600 text-white"
            : "rounded-bl-sm border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        }`}
      >
        {message.spoken && (
          <span
            className={`mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase ${isUser ? "text-indigo-100" : "text-zinc-400"}`}
          >
            <span aria-hidden>🎙</span> spoken
          </span>
        )}
        {isUser ? (
          <p className="break-words whitespace-pre-wrap">{message.text}</p>
        ) : (
          <div className="markdown break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
