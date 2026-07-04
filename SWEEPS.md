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
