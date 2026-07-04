/**
 * Playwright check for the admin dashboard (Step 7). Requires the dev server running. Uses system
 * Chrome. Generates events via a real chat, then verifies backfill, filters, and two dashboard tabs.
 * Run: npx tsx scripts/admin-check.mts
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
const headers = { "content-type": "application/json" };

/** Run one real chat turn so the dashboard has events to backfill. */
async function seedChat(): Promise<void> {
  await fetch(`${BASE}/api/reset`, { method: "POST", headers, body: "{}" });
  const sess = (await (
    await fetch(`${BASE}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerId: "cus_01" }),
    })
  ).json()) as { sessionId: string };
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId: sess.sessionId,
      message: "Refund my order ord_1001 please.",
    }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("event: done")) break;
  }
  await reader.cancel();
}

async function main() {
  await seedChat();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
    await page.getByText(/Agent reasoning dashboard/i).waitFor({ timeout: 10000 });

    // Backfill: a dashboard opened AFTER the chat must show the prior decision + tool calls.
    await page.getByText(/Decision · approved/i).waitFor({ timeout: 10000 });
    await page
      .getByText(/Tool call ·/)
      .first()
      .waitFor({ timeout: 5000 });
    await shot(page, "admin-01-backfill");

    // Filter: toggling "Tool call" off hides the tool-call rows.
    await page.getByRole("button", { name: "Tool call" }).click();
    await page
      .getByText(/Tool call ·/)
      .first()
      .waitFor({ state: "hidden", timeout: 4000 });
    // The decision is still visible (only tool_call was filtered).
    await page.getByText(/Decision · approved/i).waitFor({ timeout: 3000 });

    // Stats: at least one approved decision counted (the chip container holds the value + label).
    const approvedChip = await page
      .getByText("Approved", { exact: true })
      .locator("..")
      .textContent();
    if (!/[1-9]/.test(approvedChip ?? ""))
      throw new Error(`approved stat missing a count: "${approvedChip}"`);

    // Two dashboard tabs at once: a second tab also backfills and renders.
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page2.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
    await page2.getByText(/Decision · approved/i).waitFor({ timeout: 10000 });
    await shot(page2, "admin-02-second-tab");
    await page2.close();

    // CRITICAL (spec §3 Step 7): a FORCED error/retry sequence must display prominently end-to-end.
    // Inject a synthetic failure/retry trace through the real bus → SSE → EventSource → EventRow path.
    await fetch(`${BASE}/api/debug/emit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "sess_debugtrace" }),
    });
    const page3 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page3.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
    // The forced trace is the newest session, so it auto-selects; wait for its retry rows to backfill.
    await page3.getByText(/Retry · attempt 1\/3/).waitFor({ timeout: 10000 });
    await page3.getByText(/attempt 2\/3/).waitFor({ timeout: 4000 });
    await page3
      .getByText(/✕ failed/)
      .first()
      .waitFor({ timeout: 4000 });
    await page3.getByText(/failed after 3 attempts/).waitFor({ timeout: 4000 });

    // Prominence: retry rows carry the amber tint, error/failed rows the rose tint (EventRow `prominent`).
    const toneOf = (page: Page, re: RegExp) =>
      page
        .getByText(re)
        .first()
        .evaluate((el) => {
          let n: Element | null = el;
          while (n && !String(n.className ?? "").includes("border-l-4")) n = n.parentElement;
          return String(n?.className ?? "");
        });
    const retryTone = await toneOf(page3, /Retry · attempt 1\/3/);
    if (!/amber/.test(retryTone))
      throw new Error(`retry row not prominent (amber): "${retryTone}"`);
    const errorTone = await toneOf(page3, /failed after 3 attempts/);
    if (!/rose/.test(errorTone)) throw new Error(`error row not prominent (rose): "${errorTone}"`);

    // Accessibility: the live timeline is a focusable log region.
    const timeline = page3.locator('[role="log"]');
    if ((await timeline.count()) === 0) throw new Error("timeline missing role=log");
    if ((await timeline.first().getAttribute("tabindex")) !== "0")
      throw new Error("timeline not keyboard-focusable (tabindex!=0)");

    await shot(page3, "admin-03-error-retry");
    await page3.close();

    console.log("ADMIN CHECK RESULTS:");
    console.log("  ✓ backfill: decision + tool calls shown on open");
    console.log("  ✓ filter: toggling Tool call hides tool-call rows");
    console.log("  ✓ outcome stats show an approved count");
    console.log("  ✓ two dashboard tabs both render the session");
    console.log(
      "  ✓ forced error/retry trace renders prominently (amber retry + rose error) end-to-end",
    );
    console.log("  ✓ timeline is a focusable role=log region (keyboard + screen-reader)");
    console.log(`\nScreenshots in ${SHOTS}`);
    console.log("\nADMIN CHECK PASS");
    await browser.close();
    process.exit(0);
  } catch (err) {
    await shot(page, "admin-99-fail").catch(() => {});
    console.error("\nADMIN CHECK FAIL:", err instanceof Error ? err.message : err);
    await browser.close();
    process.exit(2);
  }
}

void main();
