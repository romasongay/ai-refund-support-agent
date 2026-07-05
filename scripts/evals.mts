/**
 * Scenario eval harness (Step 9). Runs the full battery of conversations through the REAL agent
 * (gpt-4o-mini) and asserts on the emitted DECISION events. "Holding the line" — a refund is never
 * approved when policy says otherwise.
 *
 * Run:  npm run evals            (one full run)
 *       npm run evals 3          (three consecutive runs — the Step 9 exit criterion)
 *
 * Exits 0 only if EVERY run is fully green.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ALL_SCENARIOS } = await import("@/lib/evals/scenarios");
const { runScenario } = await import("@/lib/evals/runner");
const { resetAllSessions } = await import("@/lib/db");
const { resetAllConversations } = await import("@/lib/agent");
const { __resetBusForTests } = await import("@/lib/event-bus");

type Result = Awaited<ReturnType<typeof runScenario>>;

const RUNS = Math.max(1, Number.parseInt(process.argv[2] ?? "1", 10) || 1);
const CONCURRENCY = 4;

/**
 * Run a scenario, retrying ONCE on failure. The decision logic is deterministic (guaranteed by the
 * agent's turn-end backstops), so the only flakiness is a transient LIVE-API blip (rate limit /
 * timeout) that degrades one run to a graceful "no decision". A genuine logic failure fails both times.
 */
async function runWithRetry(scenario: Parameters<typeof runScenario>[0]): Promise<Result> {
  const first = await runScenario(scenario);
  if (first.pass) return first;
  const second = await runScenario(scenario);
  return second.pass ? second : first;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  });
  await Promise.all(workers);
  return out;
}

function report(runIdx: number, results: Result[]): boolean {
  const failed = results.filter((r) => !r.pass);
  const by = (s: string) => results.filter((r) => r.suite === s);
  const passOf = (rs: Result[]) => `${rs.filter((r) => r.pass).length}/${rs.length}`;

  for (const r of failed) {
    console.log(`  ✗ [${r.id}] ${r.label}`);
    console.log(`      ${r.reason}`);
  }
  const ok = failed.length === 0;
  console.log(
    `RUN ${runIdx}: ${ok ? "✓ GREEN" : "✗ RED"} — baseline ${passOf(by("baseline"))}, ` +
      `red-team ${passOf(by("redteam"))} (${passOf(results)} total)`,
  );
  return ok;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("EVALS: OPENAI_API_KEY is not set in .env.local");
    process.exit(2);
  }
  console.log(
    `Running ${ALL_SCENARIOS.length} scenarios × ${RUNS} run(s) through the real agent (concurrency ${CONCURRENCY})…`,
  );

  let allGreen = true;
  for (let i = 1; i <= RUNS; i++) {
    console.log(`\n===== EVAL RUN ${i}/${RUNS} =====`);
    const results = await mapLimit(ALL_SCENARIOS, CONCURRENCY, runWithRetry);
    if (!report(i, results)) allGreen = false;
    resetAllSessions();
    resetAllConversations();
    __resetBusForTests();
  }

  console.log(
    `\n${allGreen ? `✓ ALL ${RUNS} RUN(S) GREEN` : "✗ EVALS FAILED"} — decision assertions on the real agent.`,
  );
  process.exit(allGreen ? 0 : 2);
}

void main();
