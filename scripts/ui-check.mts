/**
 * Playwright UI smoke for the customer chat (Step 6 adversarial focus). Requires the dev server
 * running. Uses system Chrome (no browser download). Run: npx tsx scripts/ui-check.mts
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

async function assertNoHOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 2) throw new Error(`horizontal overflow at "${label}": ${overflow}px`);
}

async function sendAndWait(page: Page, text: string) {
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  // During streaming the Send button must be disabled (prevents send-during-streaming + spam).
  await page.waitForFunction(
    (wantDisabled) => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Send",
      );
      return !!btn && (btn as HTMLButtonElement).disabled === wantDisabled;
    },
    true,
    { timeout: 6000 },
  );
  // Turn complete when the textarea is re-enabled.
  await page.waitForFunction(() => !document.querySelector("textarea")?.disabled, undefined, {
    timeout: 45000,
  });
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const results: string[] = [];
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByText(/Choose a customer/i).waitFor({ timeout: 15000 });
    await shot(page, "01-selector-desktop");
    await assertNoHOverflow(page, "selector");
    results.push("selector renders");

    // Sign in as Avery Stone (cus_01 / ord_1001 → approve).
    await page.getByRole("button", { name: /Avery Stone/ }).click();
    await page.getByText("Avery Stone").waitFor({ timeout: 8000 });
    results.push("profile selected");

    // Happy path: refund an in-window order.
    await sendAndWait(page, "Hi, I'd like a refund for my order ord_1001 please.");
    await page.getByText(/Refund approved/i).waitFor({ timeout: 5000 });
    await shot(page, "02-approved-desktop");
    await assertNoHOverflow(page, "approved conversation");
    results.push("approve flow → decision banner + reply");

    // Send-during-streaming was asserted inside sendAndWait (button disabled mid-turn).
    results.push("send disabled during streaming (spam-proof)");

    // Degenerate input: a 5,000-character message must not break the layout.
    await page.getByRole("button", { name: "Reset" }).click();
    await page.waitForTimeout(300);
    await sendAndWait(page, "A".repeat(5000) + " please refund ord_1001");
    await assertNoHOverflow(page, "5000-char message");
    await shot(page, "03-long-message-desktop");
    results.push("5000-char message handled without overflow");

    // Narrow (mobile) viewport.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    await assertNoHOverflow(page, "mobile chat");
    await shot(page, "04-chat-mobile");
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByText(/Choose a customer/i).waitFor({ timeout: 8000 });
    await assertNoHOverflow(page, "mobile selector");
    await shot(page, "05-selector-mobile");
    results.push("mobile viewport: no horizontal overflow (chat + selector)");

    console.log("UI CHECK RESULTS:");
    for (const r of results) console.log("  ✓", r);
    console.log(`\nScreenshots in ${SHOTS}`);
    console.log("\nUI CHECK PASS");
    await browser.close();
    process.exit(0);
  } catch (err) {
    await shot(page, "99-failure").catch(() => {});
    console.error("\nUI CHECK FAIL:", err instanceof Error ? err.message : err);
    await browser.close();
    process.exit(2);
  }
}

void main();
