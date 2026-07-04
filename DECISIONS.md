# DECISIONS.md

Judgment calls made during the build, per §2.3 of the Build Loop ("decide yourself, note it,
keep moving"). Format: `[Dn] Step N — decision — rationale`.

## Step 0 — Setup & Checkpoint A

- **[D1] Project location** — Scaffolded in `ai-support-agent/` (a subdirectory of the working
  dir `~/.claude`) rather than the config root. Keeps git + `node_modules` isolated from the
  user's Claude configuration. User-confirmed at Checkpoint A.
- **[D2] Package manager** — npm. Single-repo/single-deploy is locked; npm is what
  `create-next-app` produced and needs no extra tooling.
- **[D3] Toolchain versions (as pinned by `create-next-app@latest`)** — Next.js **16.2.10**
  (App Router), React **19.2.4**, TypeScript 5, Tailwind CSS **v4**, ESLint 9 (flat config).
  Not revisiting. NOTE: this Next.js major has real breaking changes vs. common knowledge
  (async `params`/`searchParams`/`cookies`/`headers`; route handlers dynamic-by-default;
  Turbopack default; `next lint` removed). Digested from `node_modules/next/dist/docs` before
  writing code, per the shipped `AGENTS.md`. Durable summary kept in scratchpad `NEXT16_NOTES.md`.
- **[D4] CSS framework** — Tailwind CSS v4 (create-next-app default). §1 requires a polished,
  demo-ready UI; Tailwind is the fastest path and the locked stack does not constrain CSS.
- **[D5] Secret handling** — `OPENAI_API_KEY` lives only in `.env.local` (git-ignored via
  `.env*`). `.env.example` is committed with a placeholder (added a `!.env.example` exception to
  `.gitignore`). Satisfies Checkpoint A + the Sweep Checklist rule "no secrets in the repo".
  The key is a non-`NEXT_PUBLIC_` var so it can never be inlined into the browser bundle.
- **[D6] Formatting** — Added Prettier (+ `prettier-plugin-tailwindcss` for class sorting, +
  `eslint-config-prettier` to disable ESLint stylistic rules), per §Step 1 "ESLint + Prettier".
- **[D7] Model config constant** — Model names are centralized in `lib/config.ts` (`MODELS`)
  from the very start, satisfying the §1 cost guard ("model names in a single config constant").
  `MODELS.text = "gpt-4o-mini"`, `MODELS.realtime = "gpt-4o-mini-realtime-preview"`. These are
  not to be upgraded without explicit human approval.
- **[D8] Test script is non-watch** — `npm test` runs `vitest run` (one-shot) so sweeps and CI
  are non-interactive; `npm run test:watch` is the watch-mode variant. Vitest cannot unit-test
  async Server Components, so all agent/tool/data logic lives in plain, testable `lib/` modules.
- **[D9] Git identity** — set **repo-local** `user.name "Mason"` / `user.email
  falconifredo@gmail.com` (from session context) so commits work; did **not** touch global git config.
  Added `.gitattributes` (`* text=auto eol=lf`) to keep line endings consistent on Windows checkouts.

## Amendment — Harvest audit of prior build

- **[D10] Prior-build audit (read-only)** — Per the user's amendment, audited the abandoned partial
  build at `C:\Users\Mason\.openclaw\workspace\refund-agent-assessment` (a Python/FastAPI + LangGraph
  + separate Next frontend). Findings recorded in `HARVEST.md`; **no code copied**; the folder is now
  off-limits for the rest of the build. Committed **separately** from the Step 1 scaffold so history
  stays clean (`harvest: …`). Key takeaways: reuse the deterministic rule-cascade + rule-ID clause
  citations + event/tool-trace design; discard LangGraph + the Python/split-backend architecture;
  the prior mock data is NOT reusable as-is (hardcoded dates, missing fields, 4 missing edge cases).
- **[D11] Pre-empt prior-build error ERR-001** — In Step 2, numeric fields like an order return-window
  are validated with Zod `.min(0)` (not `.positive()`): digital non-refundable orders legitimately use 0.

## Step 2 — Mock data & policy

- **[D12] Dates stored as relative offsets** — `data/customers.json` stores `purchasedDaysAgo` /
  `deliveredDaysAgo` (integers), never absolute calendar dates. `lib/db.ts` materializes concrete ISO
  dates against an **injectable per-session clock** (frozen at session creation). Satisfies the Step 2
  adversarial requirement "dates relative to runtime (computed offsets)"; verified by a test that shows
  window classification is invariant to the run date.
- **[D13] Item-level eligibility model** — each order carries an `items[]` array (per-item `finalSale`,
  `digital`, `condition`) with `price` = sum of item prices. This makes genuine partial refunds
  expressible (some items eligible, others not). The policy is a numbered 9-clause scheme (R1–R9) with an
  explicit **decision precedence** so every profile resolves to exactly one outcome. Damaged/defective
  (R7) has a 90-day window overriding R1/R2; partial prior refunds refund only the remainder (R5/R9).
- **[D14] Scenario oracle + independent derivation** — `data/refund-scenarios.md` records each profile's
  unambiguous expected outcome + clause (the oracle Step 3's engine must reproduce). The sweep proved
  unambiguity by having an agent re-derive all outcomes from **policy + data alone** and diffing against
  the oracle (0 mismatches across outcomes, amounts, and clause citations).
- **[D15] 15 profiles, 16 orders** — exactly 15 customer profiles (spec requirement); one customer
  (cus_15) has a second order to exercise the partial-prior-refund path without exceeding 15 profiles.
