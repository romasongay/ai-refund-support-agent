import { hasOpenAIKey } from "@/lib/config";

/**
 * Server component. Renders a non-blocking setup banner when OPENAI_API_KEY is absent, so the
 * app degrades gracefully instead of crashing (Step 1 adversarial focus). Renders nothing when
 * the key is configured.
 */
export function EnvBanner() {
  if (hasOpenAIKey()) return null;
  return (
    <div
      role="alert"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <span className="font-medium">Setup needed:</span>{" "}
      <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">OPENAI_API_KEY</code> is not
      set. Copy <code>.env.example</code> to <code>.env.local</code>, add your key, and restart. The
      UI still loads; agent replies need the key.
    </div>
  );
}
