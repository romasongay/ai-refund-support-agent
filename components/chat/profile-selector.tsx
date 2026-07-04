"use client";

import type { Profile } from "@/lib/client/api";

export function ProfileSelector({
  profiles,
  onSelect,
  busy,
}: {
  profiles: Profile[] | null;
  onSelect: (customerId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 py-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a customer to sign in</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          This simulates a logged-in customer. Pick a profile, then chat with the refund agent about
          one of their orders.
        </p>
      </div>

      {profiles === null ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => onSelect(p.id)}
              className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/40"
            >
              <span
                aria-hidden
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
              >
                {p.name
                  .split(" ")
                  .map((w) => w[0])
                  .join("")
                  .slice(0, 2)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {p.email} · {p.orderCount} order{p.orderCount === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
