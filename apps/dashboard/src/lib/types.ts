export type StaffRole = "front_desk" | "technologist" | "admin";

export interface Me {
  name: string;
  role: StaffRole;
}

export interface Metrics {
  callsToday: number;
  verifiedToday: number;
  escalatedToday: number;
  flaggedToday: number;
  medianLatencyMs24h: number | null;
  openTasks: number;
  screeningsNeedingReview: number;
}

export interface CallRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  end_reason: string | null;
  flagged: boolean;
  median_latency_ms: number | null;
  language: string;
  summary: string | null;
  intent: string | null;
  patient_name: string | null;
}

export interface CallTurn {
  seq: number;
  role: "caller" | "agent" | "tool" | "system";
  text: string | null;
  tool_name: string | null;
  tool_input: unknown;
  tool_result: { ok?: boolean; error?: { code: string; message: string }; data?: unknown } | null;
  state: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface CallDetail extends Omit<CallRow, "summary" | "intent"> {
  summary: {
    intent: string;
    outcome: string;
    actions: string[];
    follow_up_needed: boolean;
    follow_up_reason: string | null;
    flag_for_review: boolean;
    flag_reason: string | null;
    summary: string;
  } | null;
  turns: CallTurn[];
  tasks: {
    id: string;
    type: string;
    reason: string;
    status: string;
    assigned_role: string | null;
    created_at: string;
  }[];
}

export interface ScreeningRow {
  id: string;
  status: string;
  answers: Record<
    string,
    { answer: "yes" | "no" | "unsure"; callerWords: string | null; at: string }
  >;
  implants: {
    device: string;
    bodyLocation: string | null;
    callerWords: string;
    needsFollowUp: boolean;
  }[];
  rules_version: string;
  review_note: string | null;
  reviewed_at: string | null;
  appointment_ref: string;
  exam_code: string;
  starts_at: string;
  site_name: string;
  patient_name: string;
}

export interface TaskRow {
  id: string;
  type: "callback" | "review" | "transfer_failed";
  reason: string;
  status: "open" | "in_progress" | "done";
  assigned_role: StaffRole | null;
  call_id: string | null;
  screening_id: string | null;
  created_at: string;
  patient_name: string | null;
  patient_phone: string | null;
}

export interface ScheduleSlot {
  id: string;
  starts_at: string;
  duration_min: number;
  modality: string;
  status: "open" | "held" | "booked";
  site_code: string;
  site_name: string;
  appointment_ref: string | null;
  exam_code: string | null;
  created_via: string | null;
  patient_name: string | null;
}
