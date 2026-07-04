# SWEEPS.md

Adversarial Sweep Cycle log (§2.1). Acting as a hostile reviewer, every finding — however
small — is recorded here under `Step N — Sweep K`. A step closes only when **(a)** at least
three sweeps have run and **(b)** the most recent sweep produced **zero findings**.

Legend: 🔴 bug · 🟠 robustness/edge · 🟡 polish/consistency · 🟢 verified-clean.

---

## Step 1 — Sweep 1

**Mechanical gate (all pass):** `tsc --noEmit` 0 · ESLint 0 · Vitest 6/6 · `next build` OK
(`/`, `/admin`, `/_not-found` prerender) · app runs (`/` & `/admin` → 200, correct content) ·
missing-key run → setup banner + 200, no crash, no leaked stack trace · fresh-clone
(`npm ci` + build + test) reproducible from lockfile · git hygiene (`.env.local` ignored,
`.env.example` tracked, no secret staged).

**Adversarial review:** 3-lens hostile workflow (spec / next16 / hygiene) with per-finding
adversarial verification. Findings:

- 🟡 **[S1-F1]** Five unused `create-next-app` template SVGs in `public/` (dead assets). → **FIXED**: removed.
- 🟡 **[S1-F2]** `vite-tsconfig-paths` redundant under Vitest 4 (Vite resolves tsconfig paths
  natively) and emitted an advisory warning. → **FIXED**: removed plugin + dep, use `resolve.tsconfigPaths: true`.
- 🟡 **[S1-F3]** npm 11 `allow-scripts` warning for `sharp` + `unrs-resolver` (postinstall not run).
  → **ASSESSED BENIGN, no action**: build/lint/test all pass without them; approving would write to
  npm's global trust store (a side-effect outside this project). Documented; revisit only if a real breakage appears.
- 🟠 **[S1-F4]** Git index/worktree drift: the `git add -A` run during the hygiene check staged the 5
  SVGs as additions; they were then deleted from disk without staging the deletion — so a commit made
  as-is would bake 5 phantom files into history. (Surfaced by the review workflow: 3 confirmed findings
  all reduced to this one root cause.) → **FIXED**: re-staged (`git add -A`) so index matches the empty
  worktree; a final `git add -A` immediately precedes the commit.
- ℹ️ Not a defect: "zero commits yet" — by design, the baseline commit is made at step close per §2.1.

## Step 1 — Sweep 2

Re-ran the full gate after fixes: `prettier --write` then `prettier --check` 0 · `tsc` 0 · ESLint 0 ·
Vitest 6/6 · `git add -A` reconcile → `git status --short` shows **no `public/*.svg`** entries and no
split add/delete anywhere. **Findings: none new.** (F1, F2, F4 confirmed resolved; F3 confirmed benign.)

## Step 1 — Sweep 3 (clean)

Final full sweep: `next build` re-verified (exit 0, all routes prerender) + an independent hostile
re-audit of the reconciled tree (fresh agent, read-only). It confirmed: no `public/` / no tracked
SVGs / no add-delete split states; `.env.local` untracked and secret-scan clean; `.env.example`
placeholder-only; Next 16 conventions correct in every file (`'use client'` only where needed, a11y
present, no dead code / TODOs); all configs consistent; `vite-tsconfig-paths` fully removed.

**Result: CLEAN — zero findings.** Exit rule met (3 sweeps, most recent clean). Step 1 closed.

> Note: the sweeps also produced `HARVEST.md` (a read-only audit of a prior partial build, per the
> user's amendment) — committed separately from the Step 1 scaffold.

---

## Step 2 — Sweep 1

**Mechanical gate:** `prettier --check` 0 · `tsc` 0 · ESLint 0 · Vitest 29/29 (config 6 + db 23) ·
`next build` OK.

**Adversarial (independent-derivation workflow):** three parallel lenses — an agent re-derived every
profile's outcome from **policy + data alone** (no access to the answer key), diffed in code against
the expected outcomes; plus a policy-consistency lens and a data/db-spec lens.
- 🟢 **Derivation: 0 mismatches** — the independent agent reproduced all 15 expected outcomes exactly
  (outcome + amount + cited clauses). Strong evidence every profile has a single unambiguous outcome.
- 🟢 Data/db lens: no findings.
- 🟠 **[S2-F1]** Policy contradiction: R5/R9/"Amounts" describe a partial-prior-refund **remainder**, but
  the decision precedence only implemented the *fully*-refunded case and never subtracted prior refunds.
  → **FIXED**: rewrote precedence step 4 (partial prior → continue) and step 6 (`refundable = eligibleValue
  − priorRefund.amount`, with remainder / decline-if-≤0 logic) so the precedence reproduces R5/R9/Amounts.
- 🟠 **[S2-F2]** Coverage gap: no profile exercised a *partial* prior refund (only cus_06 full, cus_11
  multi-item split). → **FIXED**: added `ord_1016` to cus_15 (in-window $200 order with $80 already
  refunded → approve partial $120); added a coverage test and a `refund-scenarios.md` row + notes.

## Step 2 — Sweep 2

Re-ran the gate after Sweep-1 fixes (`prettier`/`tsc`/ESLint 0, Vitest 29/29) and re-ran the
independent derivation against the **updated** policy across all 16 requests (incl. the new
partial-prior case), plus the two audit lenses.
- 🟢 Derivation: 0 outcome/amount mismatches (partial-prior derives to the $120 remainder correctly).
- 🟢 Data/db lens: no findings.
- 🔴 **[S2-F3]** Precedence-ordering bug introduced by the S2-F1 fix: step 6 listed `refundable ≤ 0 →
  DECLINE (R5)` **before** the "no item eligible" bullet. A never-refunded ineligible order has
  `eligibleValue = 0` and `priorRefund.amount = 0`, so `refundable = 0 ≤ 0` matched first and a literal
  engine would mis-cite **R5** instead of R1/R2/R3 for four declines (ord_1002/1003/1004/1012). Outcomes
  and amounts were correct; only the cited clause was wrong — but Step 3's engine implements this
  precedence literally, so it matters. → **FIXED**: reordered step 6 so the zero-eligible case decides
  first and R5 fires only when a prior refund actually consumed eligible value.

## Step 2 — Sweep 3 (clean)

Re-derived all 16 outcomes **and clause citations** from the corrected policy, with an explicit check
that the four previously-misfiring declines do **not** cite R5, plus a final policy + data/db audit.
- 🟢 Outcome/amount mismatches: **0**.
- 🟢 Clause-citation mismatches: **0** (correct decisive clause present; no R5 mis-citation).
- 🟢 Policy audit: no findings. · 🟢 Data/db audit: no findings.

**Result: CLEAN — zero findings.** Exit rule met (3 sweeps, most recent clean). Step 2 closed.
