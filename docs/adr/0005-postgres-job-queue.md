# ADR 0005: A small Postgres job queue instead of pg-boss

- Status: accepted
- Date: 2026-10-05

## Context

Post-call summaries and implant extraction run after the caller has gone, with retries. The plan named pg-boss. pg-boss creates and migrates its own schema at runtime, so the app's database role would need `CREATE` privileges. That conflicts with the least-privilege `app_role` that makes the audit log insert-only (ADR 0002 / migration 0002).

## Decision

A `jobs` table (migration 0003) plus a ~100-line worker:

- Jobs are claimed with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, so several instances can run workers safely.
- Payloads are Zod-validated and carry ids only, never PHI.
- `dedupe_key` (unique) makes enqueueing idempotent, e.g. one summary per call.
- Retries use backoff (5 s, 30 s, 2 min), then the job is marked `failed` with the error message. Jobs left `running` for 10 minutes are reclaimed.
- The worker runs in the server process by default (`RUN_WORKER=true`) and can move to a separate process without code changes.

## Consequences

No extra schema, privileges or dependency. There are no cron-style schedules; the nightly demo reset is a Render cron job instead.
