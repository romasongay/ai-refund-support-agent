"use client";

import { useState } from "react";

/**
 * DEV-ONLY demo control. Injects the synthetic failure/retry/escalation trace (POST /api/debug/emit)
 * so the dashboard's error/retry rendering can be demonstrated LIVE during a recording without a
 * terminal. Double-gated against ever reaching a user:
 *   1. `process.env.NODE_ENV` is inlined at build time, so this whole component compiles to `null` in a
 *      production bundle — the button and its handler are tree-shaken out and never ship to the client.
 *   2. The `/api/debug/emit` endpoint itself returns 404 when `NODE_ENV === "production"`.
 * Each click uses a fresh `sess_debug_*` id so the dashboard auto-selects a brand-new, clean timeline.
 */
export function DevTraceTrigger() {
  if (process.env.NODE_ENV === "production") return null;
  return <DevTraceButton />;
}

function DevTraceButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fire = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Fresh id per click → a new session the dashboard sorts to the top and auto-selects.
      const sessionId = `sess_debug_${Date.now().toString(36)}`;
      const res = await fetch("/api/debug/emit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error(`emit failed (${res.status})`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "emit failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={fire}
        disabled={busy}
        title="Dev only — inject a simulated 503 → retry ×2 → error → R4 escalation trace onto the dashboard"
        className="rounded-full border border-amber-400/70 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/50 dark:text-amber-300 dark:hover:bg-amber-950/40"
      >
        {busy ? "Simulating…" : "⚡ Simulate failure trace"}
      </button>
      {err && <span className="text-[10px] text-rose-500">{err}</span>}
    </span>
  );
}
