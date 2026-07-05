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
  **⚠ Superseded by [D38]:** `MODELS.realtime` is now `"gpt-realtime-mini"` — the
  `gpt-4o-mini-realtime-preview` id mints an ephemeral token but 404s on `/v1/realtime/calls`.
  The mini→mini swap stays within the cost guard. See D38 for the diagnosis.
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

## Step 7 — Admin dashboard (real-time reasoning logs)

- **[D31] Firehose-only client + `import type` boundary** — `/admin` renders one client `AdminDashboard` that opens
  a SINGLE firehose `EventSource` (`/api/events` with no `sessionId`) across all sessions, deriving the session
  list, stats, and per-session timeline from that one stream. `lib/client/events-stream.ts` re-declares the event
  types as client-safe values and does an `import type` from `lib/events`, keeping `node:crypto` out of the browser
  bundle (same discipline as Step 6). A client-side `isReasoningEvent` envelope guard drops malformed frames; each
  row is wrapped in a per-row `ErrorBoundary` and the route has an `app/error.tsx`, so no single event can blank the page.
- **[D32] Firehose backfill = merged per-session histories, ordered by a publish sequence** — the event bus stamps
  each stored event with a monotonic, **non-enumerable** `SEQ` (so it never serializes onto the SSE wire) and
  `getFirehoseHistory()` reconstructs the cross-session backfill by merging the per-session histories in `SEQ`
  order. This keeps every session's full retained history backfillable regardless of other sessions' volume (no
  lossy global cap) while still honoring `Last-Event-ID` for efficient reconnect-resume. Chosen over a single global
  log after Sweep 2 showed a global cap strands a busy deployment's early per-session events (S7-F9).
- **[D33] Pagination over virtualization** — the timeline renders the latest `PAGE_SIZE` (400) events by default and
  offers a "Show older" control that pages further back through the full backfilled history. This satisfies the
  spec's "200+ events (virtualize **or** paginate)" without adding a virtualization dependency, and keeps the
  default view responsive. The page window is tagged with the session it applies to and derived at render time, so
  switching sessions resets to one page **without** a state-sync effect (avoids the `set-state-in-effect` lint rule;
  same pattern as the `effectiveId` derivation). The client store is separately bounded at `MAX_CLIENT_EVENTS` (5000).
- **[D34] Dev-only `POST /api/debug/emit` for end-to-end failure/retry verification + demo** — the spec's CRITICAL
  clause (a forced error/retry sequence must DISPLAY exactly as required) can't be forced deterministically through
  the real LLM, so a dev/test-only route injects a realistic 7-event failure/retry/escalation trace through the real
  bus→SSE→`EventRow` path. It is **inert in production** (`NODE_ENV==='production'` → 404) and restricted to a
  synthetic `sess_debug*` namespace so it can never forge a trace into a real customer session's log (S7-F10). It
  writes only to the in-memory reasoning log (no data mutation, no secrets) and doubles as the Step-10 demo's
  failure/retry beat. `scripts/admin-check.mts` uses it to assert the amber Retry + rose Error rows render prominently.
- **[D35] Accessibility of the live log** — the timeline container is a focusable `role="log"` `aria-live="polite"`
  region (`tabIndex=0` + focus ring), consistent with the `aria-pressed` filter chips and `aria-current` session
  buttons; clause chips are keyed by `${clause}-${i}` (in both the dashboard and the Step-6 banner) so duplicate
  citations can't collide on the React key and silently drop.

## Step 8 — Voice pipeline (OpenAI Realtime API over WebRTC)

- **[D36] GA ephemeral-token + WebRTC flow** — the server mints a short-lived client secret (`ek_…`) via the SDK
  `client.realtime.clientSecrets.create` (GA `/v1/realtime/client_secrets`), attaching the full session config;
  the browser then POSTs its SDP offer to `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer
  ek_…` + `Content-Type: application/sdp` (no `?model=` — the model is carried by the token's session config).
  The server API key NEVER reaches the browser. `POST /api/voice/token` returns only `{ value, expiresAt, model }`;
  TTL is 600s (`REALTIME_TOKEN_TTL_SECONDS`). Verified against the real API by `scripts/smoke-voice.mts`.
- **[D37] One policy, two transports** — `buildRealtimeSessionConfig` reuses the EXACT text-agent system prompt
  (`buildSystemPrompt`, now exported) and the SAME six tools (`realtimeTools`, derived from the same `ToolDef`
  list + Zod schemas as `openaiTools`, just flattened to the Realtime shape). Voice tool calls are forwarded by
  the browser to `POST /api/voice/tool`, which runs them through the shared `executeTool` — so the money decision
  stays code-enforced (`process_refund` re-checks eligibility internally, guarding voice exactly like text) and
  the reasoning events flow to the SAME event bus → admin dashboard automatically.
- **[D38] Cost guard for voice** — the mini realtime model (`gpt-realtime-mini`) and the mini input-transcription
  model (`gpt-4o-mini-transcribe`) both live in `lib/config.ts` (`MODELS.realtime` / `REALTIME_TRANSCRIBE_MODEL`),
  alongside `REALTIME_VOICE` and `REALTIME_CALLS_URL`. Both stay MINI tier per the cost guard (a mini→mini change,
  not a full-size upgrade — no human approval needed). Input transcription is explicitly enabled
  (`audio.input.transcription`) because it defaults OFF — without it the customer's spoken turns never emit
  transcripts, and the spec requires BOTH sides' transcripts in the chat log.
  - **Realtime-model gotcha (Checkpoint B finding, S8-F7):** `gpt-4o-mini-realtime-preview` is accepted by
    `/v1/realtime/client_secrets` (the token mints — a false green) but is NOT served by the GA WebRTC
    `/v1/realtime/calls` endpoint for this account, which 404s `model_not_found` on the real SDP call. The two
    endpoints have DIFFERENT model availability, and the codec check runs before the model check (so a dummy SDP
    hides it). Switched to `gpt-realtime-mini`, which works on both — verified by a real-browser WebRTC check
    (`scripts/voice-connect-check.mts`, fake mic → `/v1/realtime/calls` → 201). Lesson: token minting does not
    prove the call endpoint accepts the model.
- **[D39] AbortSignal lifecycle + graceful degradation** — the browser client (`lib/client/voice.ts`) is driven by
  an `AbortSignal` the mic component holds synchronously, so a stop/unmount/session-switch cancels even mid-connect
  (no leaked hot mic); `cleanup()` is idempotent and releases mic tracks + pc/dc + the audio element. Every failure
  mode is a typed `onError` → the UI degrades to text chat: unsupported browser (feature-detected via
  `useSyncExternalStore`), mic denied (DOMException name), token/connect errors, and a shared `fail()` teardown for
  all connect-side errors (incl. the Realtime data-channel `error` event). Transient ICE `disconnected` gets a 5s
  grace period before teardown (only `failed` is terminal). Testable offline via a mocked `EventSource`/`RTCPeerConnection`.
- **[D40] Verification split (automated vs. Checkpoint B)** — automatable checks are covered: token auth/expiry +
  no-key-leak, the tool round-trip (`/api/voice/tool` driven as a mocked realtime call would), mic-denied, and
  unsupported-degradation (unit + a Playwright browser check), plus a real-API `smoke-voice` proving the model +
  session config are accepted end-to-end. A real microphone can't be automated here, so the live spoken interaction
  is **Checkpoint B**: a 5-scenario human live-mic script (standard refund; policy-violation hold-the-line;
  interruption mid-sentence; ambiguous mumbled request; off-topic) whose confirmed results are required before
  Step 8's sweep can close. Checkpoint B surfaced two defects the automated sweeps could not: S8-F7 (the realtime
  model 404 — now guarded by `scripts/voice-connect-check.mts`, a real-browser WebRTC check) and S8-F8 (spoken-id
  lookup — see D41).
- **[D41] Spoken/loose identifier resolution (Checkpoint B, S8-F8)** — speech transcription drops underscores and
  casing (`ord_1001` → `ORD1001`/`order 1001`/`1,001`), so exact-string ID matching broke voice order lookups.
  Fixed at the DATA layer (not the prompt): `resolveId` in `lib/db.ts` resolves exact → case/separator-insensitive
  → bare-numeric-part, but ONLY on a unique match (ambiguous/empty/no-digit → `undefined`, never guesses), so it
  can never mis-route a refund. `getOrder`/`getCustomer` use it. To keep R6 sound, the ownership checks in the
  eligibility engine + `deny_refund` + `escalate_to_human` now compare **resolved** customer ids (`owner.id ===
  requester.id`), so a loose form can't cause a false R6 and a spoken order id owned by another customer is still
  declined. Emails already match case/whitespace-insensitively; spoken emails are lower-risk because the voice
  session binds the customer (only the order id is spoken). A 2-lens adversarial review of this money/security
  change found no collision or ownership bypass.

## Step 8 — Checkpoint B findings (F1–F4)

- **[D42] Decision events come from the deterministic engine, not the model's tool choice (F1)** — Checkpoint B
  showed the voice model would SPEAK a denial without calling `deny_refund`, so no `decision` event reached the
  dashboard. Since we can't force a specific tool call, the guarantee is code-level: `check_refund_eligibility`
  (which the model reliably calls) emits the `denied`/`escalated` decision for a terminal decline/escalate verdict;
  `process_refund` emits the `approved` decision (it performs the payout). `executeTool` canonicalizes the order id
  (spoken forms) and emits **exactly one** decision per resolved order — dedupe by canonical order, or by outcome
  when a follow-up escalate/deny carries no resolvable order key (S8-F14, caught by the money-path sweep). So every
  resolved request produces one authoritative Decision on the dashboard for BOTH transports, regardless of which
  recording tool the model additionally calls.
- **[D43] Voice transcripts on the bus (F2)** — `POST /api/voice/transcript` emits `user_message`/`assistant_message`
  so voice sessions appear on the admin dashboard exactly like text ones (a session shows up on its first turn, and
  a tool-less conversation is still visible). The client mirrors finalized transcripts there (best-effort; never
  breaks the call) in addition to rendering them locally as spoken bubbles.
- **[D44] Robust turn detection (F3)** — the realtime session sets `audio.input.noise_reduction: near_field` + a
  less-twitchy `server_vad` (threshold 0.6, silence 700ms) to reduce spurious self-interruptions while preserving
  real barge-in; validated against the live API by `smoke-voice` + `voice-connect-check`.
- **[D45] Per-profile UI copy (F4)** — the session response carries `sampleOrderId` (the bound customer's first
  order) so the empty-state hint is never a stale hardcoded id; all shipped UI copy was swept for other hardcoded
  profile/order references (README examples are handled in Step 10). Prompt rules 9–10 also fix two tone issues:
  the agent IS the support team (escalate, never defer to "contact support") and must not promise confirmation
  emails a self-contained mock won't send.

## Step 9 — Adversarial scenario hardening ("Holding the Line")

- **[D46] Eval harness asserts on emitted DECISION events, not reply text** — `npm run evals`
  (`scripts/evals.mts` + `lib/evals/*`) runs full conversations through the REAL gpt-4o-mini agent and
  asserts on the `decision` events (outcome + cited clauses): 16 oracle baselines (strict exact-decision)
  + a 7-scenario red-team suite. Red-team asserts the money guarantee `mustNotApprove` (never emit an
  approved decision) with `allowNoDecision` (a firm refusal without a formal decision still holds the line);
  a follow-up adversarial review added reply-text checks so a verbal cave ("your refund is approved!") or a
  cross-customer PII leak also fails, closing the two harness-soundness gaps (S9-F1/F2). Runs concurrently
  (4) with a per-scenario retry-once, because the decision LOGIC is deterministic (below) so the only
  residual flakiness is a transient live-API blip.
- **[D47] Every resolved request yields exactly one decision — code-level, both directions** — the agent
  loop's turn-end `settleTurn` backstop resolves EVERY order the conversation engaged (looked up or
  checked): for any engaged-but-undecided order it re-runs the deterministic engine (which emits
  denied/escalated for a terminal verdict, or marks it approvable) and then issues any approved-but-
  unprocessed refund. This mirrors the Step-8 F1 guarantee (check_refund_eligibility emits denied/escalated)
  across the APPROVE path, so a decision is recorded regardless of whether the model reliably calls
  deny_refund/process_refund. Money-safe: an entry only enters `approvable` on an approve/approve_partial
  verdict, process_refund re-checks eligibility, decisions dedupe per order, and R5 blocks a second refund —
  the money-lens adversarial review confirmed it can never issue a policy-forbidden refund. This made the
  suite pass deterministically (verified: 6 consecutive fully-green real runs; the criterion is 3).
- **[D48] Prompt tightening for the manipulation surface** — rules 2/3/6 + the flow now require the agent to
  resolve a referenced order through check_refund_eligibility before stating ANY outcome (even "obvious"
  ones and even under an injection/authority/threat/plea), to treat calling the tool with the signed-in id
  as always-safe (the tool decides ownership → R6), and to act on the verdict in the same turn. The
  deterministic engine + the settleTurn backstop are the guarantee; the prompt just steers the model there.

## Complete — Final full-system sweep

- **[D49] Backlog [M2] accepted, not "fixed" — voice transcript vs. same-exchange tool ordering** — over voice,
  a customer's finalized input transcript (`conversation.item.input_audio_transcription.completed`) can arrive
  AFTER the tool call it prompted, because the model may emit `response.function_call_arguments.done` before
  async transcription completes. The firehose orders by arrival (`SEQ`), so on the admin timeline a voice
  Customer bubble can appear just below the tool row of the same exchange. **Decision: accept and document.** The
  Realtime API exposes no reliable per-item logical clock to reorder by, and buffering transcripts to "fix" the
  order would either delay live tool/decision rows or risk holding an event that never arrives — both worse than
  a one-row cosmetic inversion. Correctness is unaffected: every event is attributed to the right session, and
  the money **decision** is code-driven and always recorded exactly once (D42/D47). Text chat is unaffected
  (server-ordered). Revisit only if the API later surfaces authored-at timestamps per conversation item.
- **[D50] Complete-step verification bar** — the final sweep cycle exercised the whole system on the shipping
  state, not just unit mocks: mechanical gate (tsc/ESLint/Prettier 0) · Vitest 171/171 (in-place AND a
  fresh `git clone` + `npm ci` + `next build` + `npm test` of the overlaid working tree) · full eval suite
  23/23 green through the real agent (decision-event assertions) · BOTH transports live (text via evals; voice
  via `voice-connect-check` → real-browser WebRTC SDP → `/v1/realtime/calls` **201**) · dashboard's three demo
  requirements confirmed on the running server via the firehose (tool_call/tool_result, a `decision`, and the
  retry×2 + error failure trace). The Complete sweep also caught two self-inflicted issues (a half-applied dead-
  export removal, and a `voice-connect-check` that raced Turbopack's cold-route compile) — both fixed before close.

## Post-launch — live-recording fixes

- **[D51] SSE preamble so a pristine dashboard connects immediately** — a fresh feed (0 backfilled events)
  wrote nothing until the first 15s heartbeat, so the platform withheld the response head and the admin
  connection pill hung on "connecting" until the first byte. `lib/sse.ts` now flushes a leading `: connected`
  comment on every connect, so `EventSource.onopen` fires at once (pill → green "open") even with zero events.
  A regression test asserts a fresh feed's first bytes are the preamble. (Prior runs always had backfill, which
  masked it.)
- **[D52] Voice reconnect is VISIBLE + config-restoring; prior conversational memory is an ACCEPTED
  limitation** — a live take saw a server-side Realtime session rotation silently swap the agent's voice, drop
  the tools, and lose context (the client had no reconnect and re-asserted config only via the ephemeral token).
  Per the GA API, `voice` is fixed at session creation and can't change via `session.update` after audio — so a
  different voice proves a new session. Fix (`lib/client/voice.ts`): a bounded (2), **visible** auto-reconnect
  (state `"reconnecting"`) triggered by a WebRTC drop OR a second `session.created` on a live channel; every
  (re)connect mints a FRESH token, so the new session is always created with our voice (alloy), the
  policy-grounded instructions binding the customer, and the tools. **Accepted limitation (decided, not built):**
  on reconnect the session is visibly fresh ("Reconnecting…") with correct **identity + policy + tools** (so an
  R6 ownership decline survives a reconnect), but **without prior conversational memory** — the earlier turns are
  not replayed into the new session. Full transcript replay was declined as new complexity in the most delicate
  subsystem right before the final recording; revisit only if conversational continuity across a reset is needed.
