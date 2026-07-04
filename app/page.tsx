export default function ChatPage() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <span className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        Customer view
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Refund Support Chat</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        The customer-facing refund chat and microphone voice component live here. Placeholder
        scaffold — the chat UI is built in Step 6 and voice in Step 8.
      </p>
    </section>
  );
}
