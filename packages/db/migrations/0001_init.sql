-- ClinicVoice initial schema. All data in this project is synthetic.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  address     text NOT NULL,
  modalities  text[] NOT NULL,
  hours       jsonb NOT NULL,
  parking     text NOT NULL
);

CREATE TABLE patients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name         text NOT NULL,
  last_name          text NOT NULL,
  dob                date NOT NULL,
  phone_last4        char(4) NOT NULL,
  phone_e164         text,
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'fr')),
  health_card_token  text
);
CREATE INDEX patients_identity_idx ON patients (dob, phone_last4);

-- A physician's order for an exam. search_slots only offers slots matching an open requisition.
CREATE TABLE requisitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  uuid NOT NULL REFERENCES patients ON DELETE CASCADE,
  exam_code   text NOT NULL,
  modality    text NOT NULL CHECK (modality IN ('MRI', 'CT')),
  contrast    boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'scheduled', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requisitions_patient_idx ON requisitions (patient_id) WHERE status <> 'closed';

CREATE TABLE slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES sites,
  modality      text NOT NULL CHECK (modality IN ('MRI', 'CT')),
  starts_at     timestamptz NOT NULL,
  duration_min  int NOT NULL CHECK (duration_min > 0),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'held', 'booked')),
  held_until    timestamptz,
  held_by_call  uuid,
  CHECK ((status = 'held') = (held_until IS NOT NULL))
);
-- Matches search_slots: modality, optional site, time window.
CREATE INDEX slots_search_idx ON slots (modality, site_id, starts_at) WHERE status <> 'booked';

CREATE TABLE appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             text UNIQUE NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patients,
  requisition_id  uuid REFERENCES requisitions,
  slot_id         uuid NOT NULL REFERENCES slots,
  exam_code       text NOT NULL,
  contrast        boolean NOT NULL DEFAULT false,
  status          text NOT NULL CHECK (status IN ('booked', 'cancelled', 'completed')),
  created_via     text NOT NULL CHECK (created_via IN ('voice', 'staff', 'seed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancel_reason   text
);
CREATE INDEX appointments_patient_idx ON appointments (patient_id, status);
-- A slot can carry at most one live booking.
CREATE UNIQUE INDEX appointments_slot_live_idx ON appointments (slot_id) WHERE status = 'booked';

CREATE TABLE calls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_sid           text UNIQUE,
  from_hash            text,
  language             text NOT NULL DEFAULT 'en',
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  verified_patient_id  uuid REFERENCES patients,
  outcome              text,
  summary              jsonb,
  median_latency_ms    int,
  flagged              boolean NOT NULL DEFAULT false
);
CREATE INDEX calls_started_idx ON calls (started_at DESC);

CREATE TABLE call_turns (
  id           bigserial PRIMARY KEY,
  call_id      uuid NOT NULL REFERENCES calls ON DELETE CASCADE,
  seq          int NOT NULL,
  role         text NOT NULL CHECK (role IN ('caller', 'agent', 'tool', 'system')),
  text         text,
  tool_name    text,
  tool_input   jsonb,
  tool_result  jsonb,
  state        text,
  latency_ms   int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, seq)
);

-- Failed identity attempts, keyed by patient and by caller hash, so a caller cannot reset the
-- lockout by hanging up and redialling.
CREATE TABLE identity_failures (
  id          bigserial PRIMARY KEY,
  patient_id  uuid REFERENCES patients,
  from_hash   text,
  call_id     uuid REFERENCES calls,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_failures_patient_idx ON identity_failures (patient_id, at);
CREATE INDEX identity_failures_from_idx ON identity_failures (from_hash, at);

CREATE TABLE screenings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid UNIQUE NOT NULL REFERENCES appointments,
  answers         jsonb NOT NULL DEFAULT '{}',
  implants        jsonb NOT NULL DEFAULT '[]',
  rules_version   text NOT NULL,
  status          text NOT NULL CHECK (status IN
                    ('in_progress', 'clear', 'needs_review', 'conditional', 'contraindicated')),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screenings_queue_idx ON screenings (status) WHERE status = 'needs_review';

CREATE TABLE staff_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text UNIQUE NOT NULL,
  display_name   text NOT NULL,
  role           text NOT NULL CHECK (role IN ('front_desk', 'technologist', 'admin')),
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE screenings
  ADD CONSTRAINT screenings_reviewed_by_fk FOREIGN KEY (reviewed_by) REFERENCES staff_users;

CREATE TABLE tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text NOT NULL CHECK (type IN ('callback', 'review', 'transfer_failed')),
  call_id        uuid REFERENCES calls,
  patient_id     uuid REFERENCES patients,
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  assigned_role  text CHECK (assigned_role IN ('front_desk', 'technologist', 'admin')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_open_idx ON tasks (status, created_at DESC);

CREATE TABLE prep_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_code  text NOT NULL,
  language   text NOT NULL CHECK (language IN ('en', 'fr')),
  body       text NOT NULL,
  version    int NOT NULL,
  approved   boolean NOT NULL DEFAULT false,
  UNIQUE (exam_code, language, version)
);

CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid NOT NULL REFERENCES patients,
  template_id   uuid REFERENCES prep_templates,
  channel       text NOT NULL CHECK (channel IN ('sms')),
  sent_at       timestamptz,
  provider_sid  text,
  status        text NOT NULL
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  request_id  text
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

-- Human-friendly appointment refs (A5001, ...). Seed data uses A1001-A1999.
CREATE SEQUENCE appointment_ref_seq START 5001;
