/**
 * Real end-to-end voice CONNECT check (Step 8 regression guard). Requires the dev server.
 * Run: npx tsx scripts/voice-connect-check.mts
 *
 * Drives the actual browser WebRTC flow with a FAKE microphone (Chrome fake media device) and asserts
 * that the SDP exchange with OpenAI's GA `/v1/realtime/calls` endpoint SUCCEEDS (2xx). This is what
 * catches a model that mints an ephemeral token but is NOT served by the calls endpoint (the
 * `model_not_found` 404 that broke Checkpoint B) — a failure the token-minting smoke cannot see.
 */
import { chromium } from "playwright";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const CALLS_RE = /api\.openai\.com\/v1\/realtime\/calls/;

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["microphone"], { origin: BASE });
  const page = await ctx.newPage();

  let callsStatus = 0;
  let callsBody = "";
  page.on("response", async (resp) => {
    if (CALLS_RE.test(resp.url())) {
      callsStatus = resp.status();
      try {
        callsBody = (await resp.text()).replace(/\s+/g, " ").slice(0, 220);
      } catch {
        callsBody = "(body unavailable)";
      }
    }
  });

  try {
    // Timeouts are deliberately generous: against a COLD dev server, Turbopack compiles each route
    // on its first request (page, /api/session, /api/voice/token — the last one right at mic-click).
    // A cold first-compile of the token route can take 10s+, so tight fixed waits produce a spurious
    // "no /v1/realtime/calls observed" failure even though the wiring is correct.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByText(/Choose a customer/i).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: /order/i }).first().click();
    const mic = page.getByRole("button", { name: /start voice conversation/i });
    await mic.waitFor({ timeout: 20000 });
    await mic.click();

    // Wait for the SDP exchange to complete (poll for the calls response) — up to 45s to absorb a
    // cold token-route compile plus the round-trip to OpenAI.
    for (let i = 0; i < 90 && callsStatus === 0; i++) await page.waitForTimeout(500);

    if (callsStatus === 0) throw new Error("no request to /v1/realtime/calls was observed");
    if (callsStatus >= 300)
      throw new Error(`/v1/realtime/calls returned ${callsStatus}: ${callsBody}`);

    console.log("VOICE CONNECT CHECK RESULTS:");
    console.log(`  ✓ browser WebRTC SDP exchange succeeded: /v1/realtime/calls → ${callsStatus}`);
    console.log("\nVOICE CONNECT CHECK PASS");
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error("\nVOICE CONNECT CHECK FAIL:", err instanceof Error ? err.message : err);
    await browser.close();
    process.exit(2);
  }
}

void main();
