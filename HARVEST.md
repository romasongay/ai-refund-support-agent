# HARVEST.md — audit of the prior partial build

**Source (read-only):** `C:\Users\Mason\.openclaw\workspace\refund-agent-assessment` — an abandoned
partial build of a refund-support agent: a **Python/FastAPI backend + a LangGraph "agent" + a separate
Next.js frontend**, with mock data, docs, and a thin `.learnings/` folder.

**Method:** read-only audit by three agents (backend/agent, frontend/docs/learnings, mock-data-vs-Step-2).
**No code was copied.** This file records ideas/patterns and decisions only. Per the amendment, that folder
is now **off-limits for the rest of the build** — everything needed from it is captured below.

**Headline:** the prior build's *architecture is off-target* for our locked decisions (it used LangGraph
and a split Python backend, and it never wired an LLM or any streaming), but several *design patterns*, its
*policy rule-ID scheme*, and its *scenario coverage* are worth adapting. Its **data files are not reusable
as-is** (hardcoded dates + missing fields + 4 missing edge cases).

---

## 1. Good ideas worth incorporating

- **Deterministic policy engine as a tool, separate from the LLM** _(→ Steps 3–4)._ The prior build put the
  approve/deny/escalate decision in a pure, ordered rule cascade returning a structured verdict — the model
  never decided money. Adopt this: `check_refund_eligibility` is a deterministic function; the agent must call
  it, and `process_refund` is gated on its passing result (enforced in code, not prompt).
- **Rule-ID clause citations** _(→ Steps 2–3)._ Policy clauses were cited by stable short codes (R1…R8) threaded
  through evaluation → decision → API → tests. Reuse this. Improvement: store the human-readable clause text
  next to each ID so a citation can render full text in the UI.
- **Two-tier verdict shape** _(→ Step 3)._ Separate an internal `RefundEvaluation` (outcome enum,
  `rules_applied: string[]`, `explanation`, `eligible_amount`) from a customer-facing `RefundDecision`
  (`customer_message`, `internal_summary`, `status`). One object for the audit trail, one for the customer.
- **Escalate-on-uncertainty default** _(→ Steps 3–4)._ Missing/ambiguous data (unknown record, missing delivery
  date, unclear digital access) → escalate, never guess. "Fail to human, not to approve."
- **Ownership / account-safety check** _(→ Step 3)._ `order.customerId !== customer.id` forces escalation — stops
  a customer requesting refunds on orders that aren't theirs. Easy to miss; keep it.
- **Structured reasoning events + tool-invocation trace** _(→ Steps 3, 5, 7)._ Prior build emitted an
  `AgentEvent` (id, ts, node/step, tool, inputs, outputs, success, reasoning_summary) and a separate
  `ToolInvocation` (tool, inputs, outputs, status, error, started/completed timestamps). This is exactly the
  contract the admin dashboard needs — the `success` boolean + `error`/`status` fields are what make
  failure/retry visualization possible. Port to Zod; stream over SSE (which the prior build never did).
- **Injectable / frozen "today" clock** _(→ Steps 2–3)._ Tools took an injectable `today` so window math is
  reproducible. Carry a frozen/injectable clock into eligibility + tests.
- **Dual identity resolution** _(→ Step 5)._ Two entry paths: resolved IDs vs. human-friendly email + order
  number (email normalized to trim/lowercase; order matched with/without an `ord_` prefix). Good UX. (But pick
  **one** canonical contract — see §2.)
- **Curated demo cases** _(→ Steps 9–10)._ A `/demo-cases`-style catalog with one representative payload per
  outcome (approve / deny-digital / deny-window / escalate-history) — cheap, and great for seeding the UI,
  smoke tests, and the demo script.
- **Tests assert the tool TRACE, not just the outcome** _(→ Steps 3–4, 9)._ e.g. assert that `lookup_customer`
  and `process_refund` actually fired, plus the decision + rule IDs + amount. Locks in agent behavior.
- **Two-pane "customer response + agent reasoning" layout** _(→ Steps 6–7)._ Left = customer request/decision;
  right = numbered workflow events with per-event success/fail pills, tool name, reasoning summary, and a
  collapsible inputs/outputs block, plus an event counter. Strong template for chat-vs-dashboard.
- **Semantic outcome color language** _(→ Steps 6–7)._ green = approve, red = deny, amber = escalate — applied
  consistently to badges, banners, and event pills. Reuse the palette (as Tailwind tokens).
- **Voice as pure transport** _(→ Step 8)._ Keep the mic as a thin input/output transport over the *same* tools
  and decision logic — don't fork policy into the voice layer. Aligns with the locked Realtime decision.
- **15-profile deterministic demo dataset mapped to outcome archetypes** _(→ Steps 2, 6)._ Each profile mapped
  to a specific policy branch, with a "Load Record" prefill. Rebuild as typed Zod fixtures + a profile selector.
- **Playwright demo/screenshot driver with semantic locators** _(→ Step 10)._ Scripted open → load record →
  fill → submit → wait-for-"Decision" → screenshot, using `getByRole`/`getByLabel`/`getByText` (not brittle CSS).
  Could double as an E2E smoke / demo-recording driver.
- **README structure** _(→ Step 10)._ overview → "what it demonstrates" → stack table → architecture tree →
  agent-flow diagram → policy highlights → run-locally → CRM table → API example → testing → known-limits.
  Reuse the skeleton; swap the stack (single-repo Next, OpenAI function-calling + Realtime, Zod, SSE); delete
  the FastAPI/LangGraph/uv sections. A candid "known limitations" section is good demo-script material.

## 2. Mistakes / dead ends to avoid

- **LangGraph orchestration — forbidden by our locked decision.** The prior agent was a `StateGraph` with nodes
  + conditional edges. It added little (a linear pipeline with one 3-way branch) and maps cleanly onto a raw
  function-calling loop. **Discard the graph/state abstraction entirely**; keep only the tool *bodies'* logic.
- **It was never actually an LLM agent.** Prompts were stubs (`TODO: replace scaffold logic with LLM call`);
  there was no function-calling, no iteration cap, no retry logic, and an `errors` list nothing populated. **We
  build the real loop from scratch:** max-iteration guard, per-tool try/catch, malformed-args handling,
  exponential backoff emitting `retry` events, graceful error messages. Nothing to harvest for loop mechanics.
- **Split Python/FastAPI backend + separate frontend + CORS + `uv`/`uvicorn`** — conflicts with single-repo
  Next 16. Collapse into App Router route handlers. Pydantic → Zod; FastAPI routes → route handlers;
  `MockRepository` re-reading JSON on every call → **load + validate fixtures once at startup, mutate in memory**.
- **No streaming was ever built** — the event trace was returned in one batch *after* evaluation, and the
  `useAgentEvents` hook was a stub returning `[]` (`// TODO: SSE/WebSocket`). This is the biggest gap vs. our
  SSE requirement. **Design streaming in from the start (Step 5):** emit events as they happen; the dashboard
  consumes a live SSE feed. A final summary payload can still exist, but the live path must not be batch-return.
- **No manipulation / prompt-injection guardrails.** The old system prompt was three sentences — safe only
  because the model decided nothing. Our LLM-driven build **must treat the customer message as untrusted data,
  never instructions**, keep the money decision in the deterministic tool, and be hardened against injection,
  gaslighting, authority claims, and wear-down (Step 9). Do not assume the old prompt is remotely sufficient.
- **Dead scaffolding, don't mistake for references:** `useAgentEvents.ts`, `AdminDashboardPlaceholder.tsx`,
  `CustomerChatPlaceholder.tsx` were empty TODO stubs; the real UI was a single-shot form in `page.tsx`. There
  is **no chat thread, no voice, no LLM/cost-guard** to reuse — all built fresh.
- **`return_window_days` was dead data** — defined in model/fixtures but ignored (windows hard-coded 30/45 in
  code). Either drive windows from data or drop the field; don't carry a field the logic silently overrides.
- **Unused enum members** (`watchlist`/`delivered`/`new`/`used` etc.) defined but never referenced — prune or wire.
- **Two overlapping API contracts** (evaluate-by-IDs vs. request-by-email/order#) — a design smell. **Pick one
  canonical identifier contract** for the new build.
- **`tsconfig target: "es5"`** — anachronistic for Next 16 / React 19. (Our scaffold already uses ES2017+.)
- **Concrete errors logged in `.learnings/ERRORS.md` — pre-empt these:**
  - _ERR-001:_ `return_window_days` validation must be **`>= 0`, not `> 0`** (digital non-refundable orders use 0).
    → Zod `.min(0)`, not `.positive()`.
  - _ERR-003:_ Next 16 production build failed collecting `/_not-found` until an explicit `app/not-found.tsx`
    existed. **Note:** our current build already prerenders `/_not-found` cleanly, but add a branded
    `not-found.tsx` in Step 6 to be safe + on-brand.
  - _ERR-004:_ Playwright's bundled browser wasn't installed; a hard-coded Windows Chrome path was used. If we
    use Playwright (Step 10), run `playwright install` or parameterize the executable path — don't hard-code it.
  - _PostCSS override_ was needed for a clean `npm audit`. Watch for the same transitive-dep audit noise.
- **`.learnings/LEARNINGS.md` and `FEATURE_REQUESTS.md` were empty** — the four `ERRORS.md` entries above are the
  entire concrete-lessons harvest; don't expect more institutional knowledge from that folder.

## 3. Mock data — validated against Step 2 requirements

**Verdict: adapt the *scenarios and policy intent*; do NOT reuse the *files*.** They need three mandatory
reworks before any value is usable. Step 2 will author fresh data informed by (not copied from) this.

**Structural rework required:**
- Prior build split `customers.json` + `orders.json` (joined by `customer_id`); Step 2 nests `orders` **inside**
  each customer in one `customers.json`. → merge.
- Field renames: `price`←`amount`, `purchase date`←`order_date`, `delivery date`←`delivery_date`, `status`←`condition`.
- **Fields to ADD (absent in prior data):** an `items[]` array (prior used a flat `product_name`); a
  **`payment method`** (entirely absent); a **per-order prior-refund flag** (prior tracked refunds only at
  customer level via a 90-day count). Note the schema files were aspirational and didn't match the real data.

**Edge-case coverage (of the 10 required by Step 2):**

| # | Edge case | Prior build | Action for Step 2 |
|---|-----------|-------------|-------------------|
| B1 | within-window (eligible) | COVERED (date-dependent) | adapt scenario; **make dates relative** |
| B2 | outside-window (>30d) | COVERED (date-dependent) | adapt scenario; **make dates relative** |
| B3 | final-sale item | PARTIAL (only custom/personalized, no `final_sale` flag) | add a true final-sale item + flag |
| B4 | already-refunded order | **MISSING** (no per-order flag) | author fresh + add per-order refund flag |
| B5 | high-value >$500 escalation | **MISSING** (max order was $199; no policy clause) | author a >$500 order + add policy clause |
| B6 | digital good (non-refundable) | COVERED | adapt |
| B7 | damaged-item claim | COVERED | adapt |
| B8 | partial refund | **MISSING** (no scenario/field) | author fresh |
| B9 | missing/mismatched order | **MISSING** (all orders valid) | author unknown-id + cross-customer mismatch |
| B10 | repeat refunder / abuse | COVERED | adapt |

**Policy (`refund_policy.md`):** prior was numbered (R1–R8) and strict, but **missing two required clauses** —
">$500 requires escalation to human review" and "one refund per order". Present: 30-day window, digital/custom
non-refundable, identity-must-match, abuse (>3/90d) → manual review. Step 2's policy must include **all six**
required rules, numbered.

**DATES — CRITICAL (this is why the files can't be reused):** every date in the prior data is a **hardcoded
absolute calendar date** (2023–2026), not a runtime-relative offset. Reused later, every order silently ages
past its window and B1 (within-window) collapses into B2 (outside-window), destroying the core eligibility
distinction. **Step 2 must compute all dates as offsets from runtime "now"** (e.g. `deliveredAt = now − N days`)
with a frozen/injectable clock for deterministic tests. This is Step 2's explicit adversarial focus.

**Net for Step 2:** build 15 fresh profiles (orders nested, correct + added fields, runtime-relative dates)
covering all 10 edge cases, plus a numbered policy with all six rules — using the prior data purely as
scenario inspiration, never as a source to copy.
