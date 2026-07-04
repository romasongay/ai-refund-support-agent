export default function AdminPage() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <span className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        Operator view
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Agent Reasoning Dashboard</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Live sessions, tool calls, decisions with policy-clause citations, and any failures or
        retries stream here in real time. Placeholder scaffold — built in Step 7.
      </p>
    </section>
  );
}
