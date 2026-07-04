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

## Step 3 — Tools layer & event bus

- **[D16] Tool architecture** — each tool is a pure `ToolDef` module (Zod input + output schemas; JSON
  schema auto-derived via Zod 4's `z.toJSONSchema`, `$schema` stripped, for the OpenAI tools array). A
  single `executeTool` executor validates I/O and publishes `tool_call` / `tool_result` / `decision` /
  `error` events — it is the ONE entry point shared by the text agent (Step 4) and the voice agent (Step 8),
  so reasoning events flow identically for both transports.
- **[D17] Money decision lives in code, guarded twice** — `check_refund_eligibility` is the deterministic
  engine; `process_refund` re-runs it internally and refuses anything not approved (code-enforced, not
  prompt-based), taking only `customerId`+`orderId` (no caller-supplied amount) so the payout can't be tampered.
- **[D18] Citations enforced structurally** — the verdict, `deny_refund`/`escalate_to_human` inputs, and
  `DecisionPayload` all use `clauses: .min(1)`, so no verdict or decision event can exist without a clause.
- **[D19] Guards from the Sweep** — `deny`/`escalate` refuse decisions on non-owned orders; `priorRefund.refunded`
  is a validated cache of `amount>0 && amount>=price` (cross-field refine) and R5 is derived from the amount;
  `executeTool` never throws (blank sessionId guarded). Event bus caps per-session history at 5000 and supports a
  firehose; global reset wiring is deferred to Step 5's `/api/reset`.

## Step 4 — Text agent loop

- **[D20] Injectable completer** — `lib/agent.ts` is a raw OpenAI (v6.45) `chat.completions` function-calling
  loop, but the network call sits behind an injectable `ChatCompleter`. This makes the entire loop
  unit-testable offline (no key, no network — 25 mock-driven tests incl. all 16 scripted flows), while the
  real completer uses `MODELS.text` (gpt-4o-mini). The system prompt embeds the policy verbatim + hard rules.
- **[D21] Layered guards + resilience** — a code-enforced ordering guard (per-conversation `checkedOrders`,
  unlocks only on approve/approve_partial) sits on top of `process_refund`'s internal re-check. Max 10 tool
  iterations → clean bail-out; max 3 retries with exponential backoff emitting `retry` events; `runAgent` never
  throws — all setup + the loop live inside try/catch and degrade to a friendly reply + `error` event.
- **[D22] Multi-turn store** — a per-session conversation transcript (system + turns + tool messages) gives
  memory across turns; `resetAllConversations` is wired into Step 5's `/api/reset`.
- **[D23] Real-API validation** — `scripts/smoke-agent.mts` (run via `tsx`, loads `.env.local` through
  `@next/env`) verifies real gpt-4o-mini approves an in-window order and refuses an authority-claim jailbreak.
  The full 15-profile + red-team battery with 3 green runs is Step 9's `npm run evals`.

## Step 5 — API layer + SSE streaming

- **[D24] Leak-free SSE helper** — `lib/sse.ts` wraps a `ReadableStream` in an SSE `Response` with a heartbeat
  and an **idempotent teardown** funnelled from abort / cancel / close, which always clears the interval and
  runs the caller's cleanup (bus unsubscribe). Client disconnect mid-stream leaves no orphaned handles.
- **[D25] Four endpoints** — `POST /api/chat` streams this turn's reasoning events + a final `done` frame (a
  per-session `inFlight` lock 409s concurrent turns; the add lives inside `onStart` so it always pairs with the
  guaranteed `.finally` delete). `GET /api/events` is per-session or firehose (`*`), **subscribes before
  backfilling** so nothing is missed/duplicated, honors `Last-Event-ID`, and is long-lived. `GET/POST
  /api/session` lists/binds profiles (+ opportunistic TTL cleanup). `POST /api/reset` scopes to one session or
  everything. All `runtime='nodejs'`, `dynamic='force-dynamic'`.
- **[D26] Two-layer verification** — a completer test-seam (`__setDefaultCompleter`) makes `/api/chat` testable
  offline (105 tests), and `scripts/smoke-api.mts` validates the real Next 16 SSE-over-HTTP + agent stack that
  the unit tests (which call handlers directly) bypass.

## Step 6 — Customer chat UI

- **[D27] Structure** — `app/page.tsx` renders a client `CustomerChat`; presentational pieces (`message-bubble`
  with react-markdown, `decision-banner`, `profile-selector`) + a client lib (`api`/`streamChat`, a pure `SseParser`,
  friendly `labels`). `import type` from `lib/events` keeps `node:crypto` out of the browser bundle.
- **[D28] Streaming UX** — the chat consumes the `/api/chat` SSE: `tool_call` → a friendly activity indicator
  ("Checking your order…"), `decision` → a prominent alert banner, `done` → the reply bubble. **Send + textarea are
  disabled while streaming**, which makes send-during-streaming and button-spam impossible client-side; each turn
  uses its own AbortController (aborted on unmount/switch/reset). Reset/Switch controls; error toast + Retry.
- **[D29] Markdown safety** — react-markdown's default (no `rehype-raw`) is XSS-safe; scoped `.markdown` CSS bounds
  code fences (`overflow-x:auto`, `max-width:100%`) so degenerate LLM output can never break the bubble/page layout.
- **[D30] Verification + persistence** — React Testing Library unit tests + a Playwright browser check
  (`scripts/ui-check.mts`, system Chrome, no download) exercise the adversarial focus (send-during-streaming,
  5000-char message, mobile overflow, markdown). **No client persistence**: a refresh returns to the profile
  selector (the server session persists in memory), which is graceful, not a break.
