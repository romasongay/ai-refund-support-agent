/**
 * Playwright check for the voice mic integration on the chat page (Step 8). Requires the dev server.
 * Verifies the mic control renders inside the chat, and that a blocked microphone degrades to a helpful
 * message (deterministically forced in-browser). The live audio round-trip is Checkpoint B (human).
 * Run: npx tsx scripts/voice-ui-check.mts
 */
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const SHOTS =
  process.env.SHOTS ??
  "C:/Users/Mason/AppData/Local/Temp/claude/C--Users-Mason--claude/8f50acca-5af0-45ac-878a-55b8f70aa283/scratchpad/ui-shots";
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function main() {
  await fetch(`${BASE}/api/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  // Force the mic-denied path deterministically, so the graceful degradation is what we assert.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new DOMException("blocked", "NotAllowedError")),
      },
    });
  });

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    // Enter the chat by selecting the first customer profile.
    await page.getByText(/Choose a customer/i).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /order/i }).first().click();

    // The mic control renders inside the chat.
    const mic = page.getByRole("button", { name: /start voice conversation/i });
    await mic.waitFor({ timeout: 10000 });
    await shot(page, "voice-01-mic-present");

    // Blocked microphone → a helpful, non-crashing message (graceful degradation).
    await mic.click();
    await page.getByText(/microphone access was blocked/i).waitFor({ timeout: 8000 });
    await shot(page, "voice-02-mic-denied");

    console.log("VOICE UI CHECK RESULTS:");
    console.log("  ✓ mic control renders inside the chat");
    console.log("  ✓ blocked microphone shows a helpful message (no crash)");
    console.log(`\nScreenshots in ${SHOTS}`);
    console.log("\nVOICE UI CHECK PASS");
    await browser.close();
    process.exit(0);
  } catch (err) {
    await shot(page, "voice-99-fail").catch(() => {});
    console.error("\nVOICE UI CHECK FAIL:", err instanceof Error ? err.message : err);
    await browser.close();
    process.exit(2);
  }
}

void main();
