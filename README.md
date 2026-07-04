# AI Customer Support Agent

An AI agent that **approves or denies e-commerce refunds** against a strict, numbered refund
policy — available over **text chat** and **live voice** (OpenAI Realtime API) — with an
**admin dashboard** that streams the agent's real-time reasoning, tool calls, decisions,
failures, and retries.

> ⚙️ This is a setup stub. The full README (architecture diagram, code tour, screenshots) and
> the timed demo script are produced in Step 10 of the build.

## Stack

- **Next.js 16** (App Router) + **TypeScript** — single repo, single deploy
- **OpenAI SDK** — raw function calling for the text agent + **Realtime API over WebRTC** for
  voice, both sharing **one tool layer** ("tools defined once, two transports")
- **Tailwind CSS v4**, **Zod** validation, **Server-Sent Events** for streaming
- **Vitest** for unit/integration tests + a scripted scenario-eval harness

## Setup

```bash
npm install
cp .env.example .env.local      # then edit .env.local and add your OPENAI_API_KEY
npm run dev                     # http://localhost:3000
```

The app loads without a key (you'll see a setup banner); the key is required for the agent to
actually reason and reply.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build & serve |
| `npm run lint` | ESLint (flat config) |
| `npm run format` | Prettier write · `npm run format:check` to verify |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (one-shot) · `npm run test:watch` for watch mode |
| `npm run evals` | Scripted agent scenario evals _(added in Step 9)_ |

## Routes

- `/` — customer chat + microphone voice component
- `/admin` — real-time agent reasoning dashboard
