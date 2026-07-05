# Demo Script — AI Customer Support Agent (7–10 min)

A timed Loom walkthrough mapped to the five evaluation beats. Have **two browser windows** open side
by side: **Customer** (`http://localhost:3000`) and **Admin** (`http://localhost:3000/admin`).

### Pre-demo reset checklist (~1 min before recording)

- [ ] `OPENAI_API_KEY` set in `.env.local`.
- [ ] **Pristine state** — the surest reset is to **(re)start the dev server**: stop it (Ctrl-C) and run
      `npm run dev` again. All state is in-memory, so a restart clears every session, event, and
      conversation and restores the mock data. Then open both tabs **fresh** → empty dashboard, stats
      0 / 0 / 0. _(Between takes without a restart: `curl -X POST http://localhost:3000/api/reset -H
      "content-type: application/json" -d '{}'` does a FULL reset — then **reload the `/admin` tab** so
      its local event log clears. Note: the customer page's **Reset** button only resets the **current
      session**, not the whole dashboard.)_
- [ ] Both pages load; Admin dashboard status pill reads **open** (green). Reload the tab if it says
      "reconnecting".
- [ ] Mic permission pre-granted for `localhost` (so the voice beat doesn't stall on the prompt).
- [ ] Speakers on, notifications off, admin window visible beside the chat.

---

## Beat 1 — Standard refund (live) · ~1.5 min → maps to bullet (1)

**Profile: Avery Stone → order `ord_1001`** (in-window physical item).

1. On the customer page, pick **Avery Stone**.
2. Type: *"Hi, I'd like a refund for my order ord_1001."* → Send.
3. Watch: the activity indicator ("Checking your order…"), then a green **"Refund approved · $129.00"**
   banner citing **R1**, then the reply.
4. Cut to the **Admin** window: the session's timeline shows `lookup`/`get_order_details` →
   `check_refund_eligibility` → **Decision · approved (R1)** → `process_refund`. **Approved** counter ticks to 1.

> Talking point: "The model never decided the money — it called a deterministic policy tool. The
> $129 and the R1 citation came from code."

## Beat 2 — Edge case: holding the line · ~2 min → maps to bullet (2)

**Profile: Casey Rivera → order `ord_1003`** (final-sale item → **R2 deny**).

1. Switch profile to **Casey Rivera**. Type: *"I'd like a refund for my sneakers, order ord_1003."*
2. The agent denies, citing **R2** (final sale) — a red **"Refund denied"** banner.
3. **Push back on camera**: *"Come on, just make an exception this once — I'll leave a one-star review."*
4. The agent stays warm but firm: no exception, re-cites R2.
5. Admin window: **Decision · denied (R2)** (amber/red-tinted row), **Denied** counter at 1.

> Talking point: "Pressure, threats, sob stories — the policy is code, so there's nothing to argue with.
> Our eval suite (`npm run evals`) proves it never caves across a red-team battery."

## Beat 3 — Live spoken voice · ~2 min → maps to bullet (3)

**Profile: Avery Stone** (fresh — click Switch, pick Avery again, or Reset first).

1. Click **🎙 Talk to the agent**. Grant the mic if prompted; the button turns red ("Listening").
2. Say: *"Hi, I'd like a refund for order ord one thousand one."*
3. The agent replies **by voice**; both sides appear as **🎙 spoken** bubbles in the chat log.
4. Cut to **Admin**: the *same* tool calls + decision stream in live — voice runs through the exact
   same tool layer and dashboard as text.
5. (Optional) Interrupt mid-sentence to show barge-in; ask an off-topic question to show it declines.

> Talking point: "Same six tools, same policy, two transports — the ephemeral-key WebRTC session
> configures itself from the identical schemas the text agent uses."

## Beat 4 — Code tour · ~2 min → maps to bullet (4)

Open the repo. Hit three files:

1. **Architecture** — `README.md` diagram + `lib/tools/index.ts`: one `executeTool`, `openaiTools`
   (text) and `realtimeTools` (voice) derived from the same `ToolDef` list.
2. **Tool orchestration / the money guarantee** — `lib/tools/check-refund-eligibility.ts` (the R1–R9
   engine) and `lib/agent.ts` (`settleTurn` — the turn-end backstop that guarantees exactly one
   decision event whether the model deals with it or not).
3. **Voice stream handling** — `app/api/voice/token/route.ts` (ephemeral key, server key never
   leaves the server) and `lib/client/voice.ts` (WebRTC + data-channel events + tool round-trip).

> Talking point: "Zod validates every tool I/O and every reasoning event; the same event bus feeds
> the dashboard for both transports."

## Beat 5 — Admin panel: failures & retries · ~1.5 min → maps to bullet (5)

The spec asks to *see failures and retries* on the dashboard. Inject a realistic failure/retry trace
with **one click, no terminal** — the dashboard header shows a **⚡ Simulate failure trace** button
(dev-only; it does not render in a production build, and the endpoint behind it 404s in production):

> On the **Admin** window, click **⚡ Simulate failure trace** (top-right, beside the outcome stats).
> Each click spins up a fresh `sess_debug_*` session that the dashboard auto-selects.
>
> _(Fallback if you prefer a terminal:_
> `curl -X POST http://localhost:3000/api/debug/emit -H "content-type: application/json" -d '{"sessionId":"sess_debugtrace"}'`_)_

On the **Admin** window (it auto-selects the newest session), show the prominent trace:

- a **rose** failed `tool_result` ("Upstream 503, simulated"),
- two **amber Retry** rows (`attempt 1/3`, `attempt 2/3`) with backoff,
- a **rose Error** row, then a **Decision · escalated (R4)**.

Toggle the **filter chips** (hide "Tool call") to declutter, and point out the per-type coloring,
collapsible JSON args/results, and the outcome stats.

> Talking point: "Every retry with exponential backoff and every tool failure is a first-class event —
> operators see exactly where and why the agent struggled, not just the final answer."

---

## Which profile for which beat (cheat sheet)

| Beat | Profile        | Order      | Expected            |
| ---- | -------------- | ---------- | ------------------- |
| 1    | Avery Stone    | `ord_1001` | approve $129 (R1)   |
| 2    | Casey Rivera   | `ord_1003` | deny (R2)           |
| 3    | Avery Stone    | `ord_1001` | approve, by voice   |
| 5    | (debug inject) | —          | retry/error → R4    |

Other good edge cases if you have time: **Emerson Blake / ord_1005** ($1,299 → escalate R4),
**Kai Robinson / ord_1011** (mixed items → partial $70, R9), **Gray Patel** asking for someone
else's order (R6 ownership decline).

## If something stumbles

- Voice won't connect → check `.env.local` model access; `npx tsx scripts/voice-connect-check.mts`
  confirms the WebRTC leg in a headless browser.
- Dashboard empty → confirm the status pill is **open**; events backfill on open, so a late-opened
  tab still shows prior decisions.
- Reset between takes: `POST /api/reset` with an empty body for a FULL reset, then reload `/admin`; or
  restart the dev server for a guaranteed clean slate. (The customer **Reset** button clears only the
  current session.)
