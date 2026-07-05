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
  /**
   * Voice pipeline (OpenAI Realtime API), mini tier. Must be a model served by the GA WebRTC
   * `/v1/realtime/calls` endpoint — NOT just accepted by `/v1/realtime/client_secrets`. The older
   * `gpt-4o-mini-realtime-preview` mints a token but 404s (`model_not_found`) on the actual call;
   * `gpt-realtime-mini` is the current GA mini realtime model and works on both.
   */
  realtime: "gpt-realtime-mini",
} as const;

export type ModelName = (typeof MODELS)[keyof typeof MODELS];

/** OpenAI REST base (kept here so it, too, lives in one place). */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Realtime voice config (Step 8). The browser POSTs its WebRTC SDP offer here with the short-lived
 * ephemeral key; the model itself is carried by that key's server-side session config (no query param).
 */
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** The realtime voice the agent speaks with (kept in one place alongside the model). */
export const REALTIME_VOICE = "alloy";

/**
 * Input-audio transcription model (mini tier, cost-guard-aligned). Realtime input transcription is
 * OFF by default and runs as a separate ASR pass; enabling it is what makes the CUSTOMER's spoken
 * words surface as transcripts in the chat log (the assistant side is transcribed natively).
 */
export const REALTIME_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/** Ephemeral client-secret TTL in seconds (10 min: long enough to start a call, short enough to be safe). */
export const REALTIME_TOKEN_TTL_SECONDS = 600;

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
