/**
 * Voice (Realtime API) ephemeral-token minting. The browser must NEVER see the server API key, so the
 * server exchanges it for a short-lived client secret (`ek_…`) whose session config carries the SAME
 * system prompt + tool schemas as the text agent — one policy, two transports.
 *
 * The actual OpenAI call sits behind an injectable creator (mirroring the agent's completer seam), so
 * the token route's success path is unit-testable without a key or a network call.
 */
import OpenAI from "openai";
import {
  MODELS,
  REALTIME_TOKEN_TTL_SECONDS,
  REALTIME_TRANSCRIBE_MODEL,
  REALTIME_VOICE,
  requireOpenAIKey,
} from "@/lib/config";
import type { Session } from "@/lib/db";
import { buildSystemPrompt } from "@/lib/agent";
import { realtimeTools } from "@/lib/tools";

/** The Realtime session configuration attached to the ephemeral secret. */
export interface RealtimeSessionConfig {
  type: "realtime";
  model: string;
  instructions: string;
  audio: {
    input: {
      // Enabling input transcription is what surfaces the CUSTOMER's spoken words in the chat log.
      transcription: { model: string };
      // Reduce false VAD triggers (headset/close-talking mic) so the agent doesn't interrupt itself.
      noise_reduction: { type: "near_field" };
      // Server VAD: keep interrupt-on-speech (real barge-in) but be less twitchy about noise — a higher
      // threshold + longer trailing silence avoids spurious self-interruptions / duplicate responses.
      turn_detection: {
        type: "server_vad";
        threshold: number;
        prefix_padding_ms: number;
        silence_duration_ms: number;
      };
    };
    output: { voice: string };
  };
  tools: typeof realtimeTools;
  tool_choice: "auto";
}

/** Build the Realtime session config for a customer session (same grounding + tools as the text agent). */
export function buildRealtimeSessionConfig(session: Session): RealtimeSessionConfig {
  return {
    type: "realtime",
    model: MODELS.realtime,
    instructions: buildSystemPrompt(session),
    audio: {
      input: {
        transcription: { model: REALTIME_TRANSCRIBE_MODEL },
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
        },
      },
      output: { voice: REALTIME_VOICE },
    },
    tools: realtimeTools,
    tool_choice: "auto",
  };
}

export interface VoiceToken {
  value: string;
  expiresAt: number;
  model: string;
}

export type ClientSecretCreator = (
  config: RealtimeSessionConfig,
) => Promise<{ value: string; expiresAt: number }>;

let creatorOverride: ClientSecretCreator | null = null;

/** Test seam: inject a fake secret creator so the token route can be tested without OpenAI. */
export function __setClientSecretCreator(creator: ClientSecretCreator | null): void {
  creatorOverride = creator;
}

const realCreator: ClientSecretCreator = async (config) => {
  const client = new OpenAI({ apiKey: requireOpenAIKey() });
  const secret = await client.realtime.clientSecrets.create({
    expires_after: { anchor: "created_at", seconds: REALTIME_TOKEN_TTL_SECONDS },
    // The SDK's RealtimeSessionCreateRequest is a wide union; our config is a valid realtime subset.
    session: config as unknown as Parameters<
      typeof client.realtime.clientSecrets.create
    >[0]["session"],
  });
  return { value: secret.value, expiresAt: secret.expires_at };
};

/**
 * Mint an ephemeral Realtime client secret for a customer session. Returns only the browser-safe
 * fields (the `ek_…` value, its expiry, and the model) — never the server key.
 */
export async function createVoiceToken(session: Session): Promise<VoiceToken> {
  const config = buildRealtimeSessionConfig(session);
  const { value, expiresAt } = await (creatorOverride ?? realCreator)(config);
  return { value, expiresAt, model: MODELS.realtime };
}
