-- Background jobs (post-call summaries, implant extraction), LLM usage for the spend cap, and
-- change notifications that drive the dashboard's live updates.

-- A small Postgres-backed queue: workers claim with FOR UPDATE SKIP LOCKED. Chosen over pg-boss
-- so the app role needs no CREATE SCHEMA privilege (see ADR 0005).
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 3,
  run_after     timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  dedupe_key    text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (run_after) WHERE status = 'queued';

-- Token usage per model call. The daily budget check sums today's rows.
CREATE TABLE llm_usage (
  id                   bigserial PRIMARY KEY,
  at                   timestamptz NOT NULL DEFAULT now(),
  call_id              uuid REFERENCES calls ON DELETE SET NULL,
  purpose              text NOT NULL,
  model                text NOT NULL,
  input_tokens         int NOT NULL,
  cached_input_tokens  int NOT NULL DEFAULT 0,
  output_tokens        int NOT NULL
);
CREATE INDEX llm_usage_at_idx ON llm_usage (at);

-- Review tasks link to the screening that raised them, so each screening raises at most one.
ALTER TABLE tasks ADD COLUMN screening_id uuid REFERENCES screenings;
CREATE UNIQUE INDEX tasks_one_review_per_screening ON tasks (screening_id) WHERE type = 'review';

ALTER TABLE tasks ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE calls ADD COLUMN end_reason text;

-- Dashboard live updates: one NOTIFY per change, carrying only table and id (never PHI).
CREATE FUNCTION notify_dashboard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'dashboard_events',
    json_build_object('table', TG_TABLE_NAME, 'id', NEW.id::text, 'op', lower(TG_OP))::text
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER calls_notify AFTER INSERT OR UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION notify_dashboard();
CREATE TRIGGER tasks_notify AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION notify_dashboard();
CREATE TRIGGER screenings_notify AFTER INSERT OR UPDATE ON screenings
  FOR EACH ROW EXECUTE FUNCTION notify_dashboard();
CREATE TRIGGER appointments_notify AFTER INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION notify_dashboard();
