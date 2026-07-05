/**
 * Real-API smoke test for the voice pipeline's server side (Step 8).
 * Run: npx tsx scripts/smoke-voice.mts   (loads OPENAI_API_KEY from .env.local)
 *
 * Confirms the real OpenAI Realtime wiring WITHOUT a microphone: it mints an ephemeral client secret
 * (`ek_…`) with our session config — proving the configured mini realtime model + tool schemas + policy
 * prompt are ACCEPTED by OpenAI's `/v1/realtime/client_secrets` endpoint. The live mic call itself is
 * Checkpoint B (human). Also asserts the secret is short-lived and the server key never appears.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { createSession } = await import("@/lib/db");
const { createVoiceToken } = await import("@/lib/voice/token");
const { MODELS } = await import("@/lib/config");

async function main() {
  const serverKey = process.env.OPENAI_API_KEY ?? "";
  if (!serverKey) {
    console.error("VOICE SMOKE FAIL: OPENAI_API_KEY is not set in .env.local");
    process.exit(2);
  }

  const session = createSession({ boundCustomerId: "cus_01" });
  console.log(`Minting a realtime client secret with model "${MODELS.realtime}"…`);

  try {
    const token = await createVoiceToken(session);
    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = token.expiresAt - nowSec;

    const okValue = typeof token.value === "string" && token.value.startsWith("ek_");
    const okExpiry = token.expiresAt > nowSec && ttl <= 7200;
    const okModel = token.model === MODELS.realtime;
    const noLeak = !JSON.stringify(token).includes(serverKey);

    console.log("\nVOICE SMOKE RESULTS:");
    console.log(
      `  ${okValue ? "✓" : "✗"} ephemeral key returned (ek_…): ${token.value.slice(0, 8)}…`,
    );
    console.log(`  ${okExpiry ? "✓" : "✗"} short-lived: expires in ~${ttl}s`);
    console.log(`  ${okModel ? "✓" : "✗"} model minted by /client_secrets: ${token.model}`);
    console.log(`  ${noLeak ? "✓" : "✗"} server key not present in the response`);
    console.log(
      "  NOTE: minting acceptance does NOT prove the model is served by /v1/realtime/calls —",
    );
    console.log("        `scripts/voice-connect-check.mts` validates the actual WebRTC call.");

    if (okValue && okExpiry && okModel && noLeak) {
      console.log("\nVOICE SMOKE PASS");
      process.exit(0);
    }
    console.error("\nVOICE SMOKE FAIL: one or more checks failed");
    process.exit(2);
  } catch (err) {
    console.error("\nVOICE SMOKE FAIL:", err instanceof Error ? err.message : err);
    console.error(
      "If the model was rejected, the configured MODELS.realtime may need a different mini-tier realtime id.",
    );
    process.exit(2);
  }
}

void main();
