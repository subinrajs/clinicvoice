import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** Kysely table types. Keep in lockstep with migrations/*.sql. */

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** Timestamp with a database default (e.g. now()); optional on insert. */
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T> = ColumnType<T, string, string>;

export interface SiteHours {
  /** ISO weekday 1 (Mon) to 7 (Sun) mapped to "HH:MM-HH:MM", or null when closed. */
  [isoWeekday: string]: string | null;
}

export interface SitesTable {
  id: Generated<string>;
  code: string;
  name: string;
  address: string;
  modalities: string[];
  hours: Json<SiteHours>;
  parking: string;
}

export interface PatientsTable {
  id: Generated<string>;
  first_name: string;
  last_name: string;
  dob: ColumnType<string, string, string>;
  phone_last4: string;
  phone_e164: string | null;
  preferred_language: Generated<string>;
  health_card_token: string | null;
}

export interface RequisitionsTable {
  id: Generated<string>;
  patient_id: string;
  exam_code: string;
  modality: string;
  contrast: Generated<boolean>;
  status: Generated<string>;
  created_at: GeneratedTimestamp;
}

export interface SlotsTable {
  id: Generated<string>;
  site_id: string;
  modality: string;
  starts_at: Timestamp;
  duration_min: number;
  status: Generated<string>;
  held_until: Timestamp | null;
  held_by_call: string | null;
}

export interface AppointmentsTable {
  id: Generated<string>;
  ref: string;
  patient_id: string;
  requisition_id: string | null;
  slot_id: string;
  exam_code: string;
  contrast: Generated<boolean>;
  status: string;
  created_via: string;
  created_at: GeneratedTimestamp;
  cancel_reason: string | null;
}

export interface CallsTable {
  id: Generated<string>;
  twilio_sid: string | null;
  from_hash: string | null;
  language: Generated<string>;
  started_at: GeneratedTimestamp;
  ended_at: Timestamp | null;
  verified_patient_id: string | null;
  outcome: string | null;
  summary: Json<unknown> | null;
  median_latency_ms: number | null;
  flagged: Generated<boolean>;
  end_reason: string | null;
}

export interface CallTurnsTable {
  id: Generated<string>;
  call_id: string;
  seq: number;
  role: "caller" | "agent" | "tool" | "system";
  text: string | null;
  tool_name: string | null;
  tool_input: Json<unknown> | null;
  tool_result: Json<unknown> | null;
  state: string | null;
  latency_ms: number | null;
  created_at: GeneratedTimestamp;
}

export interface IdentityFailuresTable {
  id: Generated<string>;
  patient_id: string | null;
  from_hash: string | null;
  call_id: string | null;
  at: GeneratedTimestamp;
}

export interface ScreeningsTable {
  id: Generated<string>;
  appointment_id: string;
  answers: Json<Record<string, unknown>>;
  implants: Json<unknown[]>;
  rules_version: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  review_note: string | null;
  updated_at: GeneratedTimestamp;
}

export interface StaffUsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  role: string;
  password_hash: string;
  created_at: GeneratedTimestamp;
}

export interface TasksTable {
  id: Generated<string>;
  type: string;
  call_id: string | null;
  patient_id: string | null;
  reason: string;
  status: Generated<string>;
  assigned_role: string | null;
  screening_id: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PrepTemplatesTable {
  id: Generated<string>;
  exam_code: string;
  language: string;
  body: string;
  version: number;
  approved: Generated<boolean>;
}

export interface MessagesTable {
  id: Generated<string>;
  patient_id: string;
  template_id: string | null;
  channel: string;
  sent_at: Timestamp | null;
  provider_sid: string | null;
  status: string;
}

export interface AuditLogTable {
  id: Generated<string>;
  at: GeneratedTimestamp;
  actor: string;
  action: string;
  entity: string;
  entity_id: string;
  request_id: string | null;
}

export interface JobsTable {
  id: Generated<string>;
  type: string;
  payload: Json<unknown>;
  status: Generated<"queued" | "running" | "done" | "failed">;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_after: GeneratedTimestamp;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface LlmUsageTable {
  id: Generated<string>;
  at: GeneratedTimestamp;
  call_id: string | null;
  purpose: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: Generated<number>;
  output_tokens: number;
}

export interface Database {
  sites: SitesTable;
  patients: PatientsTable;
  requisitions: RequisitionsTable;
  slots: SlotsTable;
  appointments: AppointmentsTable;
  calls: CallsTable;
  call_turns: CallTurnsTable;
  identity_failures: IdentityFailuresTable;
  screenings: ScreeningsTable;
  staff_users: StaffUsersTable;
  tasks: TasksTable;
  prep_templates: PrepTemplatesTable;
  messages: MessagesTable;
  audit_log: AuditLogTable;
  jobs: JobsTable;
  llm_usage: LlmUsageTable;
}

export type Site = Selectable<SitesTable>;
export type Patient = Selectable<PatientsTable>;
export type Slot = Selectable<SlotsTable>;
export type Appointment = Selectable<AppointmentsTable>;
export type NewTask = Insertable<TasksTable>;
export type NewCallTurn = Insertable<CallTurnsTable>;
export type NewAuditEntry = Insertable<AuditLogTable>;
export type ScreeningUpdate = Updateable<ScreeningsTable>;
