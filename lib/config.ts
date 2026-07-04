/**
 * Central configuration.
 *
 * COST GUARD (§1 of the build spec): every model name in the entire app is declared HERE and
 * nowhere else, so the tier can be swapped in one place. Do not upgrade to full-size models
 * without explicit human approval.
 */
export const MODELS = {
  /** Text agent + eval-harness calls. */
  text: "gpt-4o-mini",
  /** Voice pipeline (OpenAI Realtime API), mini tier. */
  realtime: "gpt-4o-mini-realtime-preview",
} as const;

export type ModelName = (typeof MODELS)[keyof typeof MODELS];

/** OpenAI REST base (kept here so it, too, lives in one place). */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Whether an OpenAI API key is configured. Safe to call anywhere on the server; never exposes
 * the key value. Used to render a helpful setup banner instead of crashing when the key is absent.
 */
export function hasOpenAIKey(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Returns the OpenAI API key, or throws a friendly, actionable error. The error message never
 * includes the key itself.
 */
export function requireOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set. Copy .env.example to .env.local, add your key, and restart the server.",
    );
  }
  return key;
}
