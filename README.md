# ClinicVoice

An AI phone agent for **Lakeshore MRI & CT**, a fictional three-site imaging clinic. It answers calls, verifies callers, looks up and changes bookings, runs MRI safety pre-screening, and hands anything clinical to staff.

> **Portfolio project. All data is synthetic.** The RIS is a mock, no real patient data is used, and this is not a medical device. It is built the way a PHIPA-covered deployment would be, so the controls are real even though the data isn't.

## Design principles

Safety lives in code first and the prompt second, so a prompt failure degrades into an escalation, not an unsafe action.

| Guarantee                                                         | Enforced by                                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No patient data before identity is verified                       | `requireVerified` guard and state-derived tool allow-list ([state.ts](apps/server/src/session/state.ts))                                                 |
| No write without the caller's spoken yes, for those exact details | `propose_action` → deterministic `classifyConfirmation` → `requireConfirmed` deep-equality ([ADR 0002](docs/adr/0002-confirmation-outside-the-model.md)) |
| Lockout can't be reset by redialling                              | Per-call limit plus per-patient/per-caller window in `identity_failures`                                                                                 |
| The agent can never mark a screening clear                        | Rules engine returns only `in_progress` / `needs_review` ([rules.ts](apps/server/src/screening/rules.ts))                                                |
| Clinical advice is never spoken                                   | Sentence-buffered output filter before text-to-speech ([outputFilter.ts](apps/server/src/agent/outputFilter.ts))                                         |
| Every read and write of patient data is recorded                  | Insert-only `audit_log`; the app role is denied UPDATE and DELETE (integration-tested)                                                                   |
| No PHI in logs                                                    | pino redaction paths; caller numbers stored as keyed HMAC                                                                                                |

## Architecture

```
Caller ⇄ Twilio ConversationRelay ⇄ /ws (call session) ⇄ Claude (streaming, tool use)
                                          │
                                     tool layer (guards, audit)
                                          │
                                   Postgres ⇄ mock RIS ⇄ staff dashboard
```

```
apps/server        Fastify: /voice webhook, /ws ConversationRelay, /ris/v1 mock RIS, health checks
  src/agent        Claude tool loop, prompt loading, output filter, history trimming
  src/session      call session, derived state, confirmation classifier
  src/tools        defineTool + guards + one file per tool
  src/screening    versioned MRI screening rules
  src/repositories Postgres data access behind interfaces (faked in unit tests)
  src/telephony    relay protocol, TwiML, per-call WebSocket handler
apps/dashboard     React + Vite staff dashboard (milestone 3)
packages/db        SQL migrations, Kysely types, migration runner, deterministic seed
packages/shared    domain enums, exam catalogue, tool error codes
prompts/           versioned prompts (voice-agent.v1.md)
docs/adr/          architecture decision records
```

## Getting started

Requirements: Node 22+, pnpm 12, Docker.

```bash
pnpm install
cp .env.example .env          # fill in the keys; see comments in the file
pnpm db:up                    # local Postgres 16 (creates the app login role)
pnpm db:migrate               # runs as the schema owner
pnpm seed                     # 3 sites, 40 patients, 2 weeks of slots, demo staff logins
pnpm dev                      # server on :3000
pnpm dev:dashboard            # dashboard on :5173
```

To take real calls locally, expose the server with a stable tunnel (for example an ngrok reserved domain), set `PUBLIC_BASE_URL` to it, and point the Twilio number's voice webhook at `POST {PUBLIC_BASE_URL}/voice`.

Demo staff logins (seeded): `frontdesk@`, `tech@`, `admin@lakeshore.example`, with password `SEED_STAFF_PASSWORD` (default `lakeshore-demo`, local only). Demo patients are listed in [tests/conversations](tests/conversations/README.md).

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- **Unit tests** (Vitest, no network): guards, confirmation matching, classifier, derived state, screening rules, speakable dates, output filter, agent loop with a scripted fake model, WebSocket call handler.
- **Integration tests** run against real Postgres when `TEST_DATABASE_URL` (app role) and `TEST_DATABASE_MIGRATION_URL` (owner) are set. They cover audit-log immutability, double-booking prevention, atomic reschedule, and cross-patient cancellation. CI provides both.
- **Scripted conversations** (10 scripts, 3 of 3 runs each against the real model) are added in milestone 3.

## Deployment

| Piece                                                        | Host                              |
| ------------------------------------------------------------ | --------------------------------- |
| Server (`apps/server/Dockerfile`, long-lived for WebSockets) | Render or Fly.io, always-on       |
| Dashboard (static)                                           | Vercel                            |
| Postgres                                                     | Supabase or Neon, Canadian region |
| Telephony and SMS                                            | Twilio                            |

In production, create a login user in `app_role` for `DATABASE_URL`, and run migrations with the owner credentials in `DATABASE_MIGRATION_URL`. Twilio signatures are enforced when `NODE_ENV=production`.

## Roadmap

- [x] **Day 1 (foundation):** monorepo, schema and migrations, seed, mock RIS, tool framework and guards, voice loop port, CI
- [ ] **M1:** live call verifies identity and reads back an appointment, with latency logged
- [ ] **M2:** search, hold, book, cancel with confirmation; screening; prep SMS
- [ ] **M3:** transfer and callbacks, post-call summaries, scripted suite, dashboard
- [ ] **M4:** deployed, documented, 10 live calls logged, video
