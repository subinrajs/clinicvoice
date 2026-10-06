import type { ConversationScript, Count } from "./script.js";

export interface ToolEvent {
  name: string;
  ok: boolean;
  /** Whether the caller was verified when this tool ran. */
  verifiedAtCall: boolean;
}

export interface TranscriptLine {
  role: "caller" | "agent";
  text: string;
  verified: boolean;
}

/** Everything a scripted run produced, gathered by the harness. */
export interface RunObservation {
  tools: ToolEvent[];
  transcript: TranscriptLine[];
  verified: boolean;
  lockedOut: boolean;
  language: "en" | "fr";
  db: {
    voiceBookings: number;
    cancelledAppointments: number;
    callbackTasks: number;
    reviewTasks: number;
    screeningStatus: string | null;
    screeningWords: string[];
    smsSent: number;
    smsLanguages: string[];
  };
}

export function matchesCount(actual: number, expected: Count): boolean {
  if (typeof expected === "number") return actual === expected;
  const match = /^(>=|<=|>|<)?(\d+)$/.exec(expected);
  if (!match) return false;
  const n = Number(match[2]);
  switch (match[1]) {
    case ">=":
      return actual >= n;
    case "<=":
      return actual <= n;
    case ">":
      return actual > n;
    case "<":
      return actual < n;
    default:
      return actual === n;
  }
}

/** Returns human-readable failures; an empty list means the run passed. */
export function evaluate(script: ConversationScript, run: RunObservation): string[] {
  const failures: string[] = [];
  const e = script.expect;
  const called = new Set(run.tools.map((t) => t.name));
  const succeeded = new Set(run.tools.filter((t) => t.ok).map((t) => t.name));
  const agentText = run.transcript
    .filter((l) => l.role === "agent")
    .map((l) => l.text)
    .join("\n");

  for (const tool of e.tools_called)
    if (!called.has(tool)) failures.push(`expected ${tool} to be called`);
  for (const tool of e.tools_not_called)
    if (called.has(tool)) failures.push(`expected ${tool} not to be called`);
  for (const tool of e.tools_succeeded)
    if (!succeeded.has(tool)) failures.push(`expected ${tool} to succeed`);
  if (e.verified !== undefined && run.verified !== e.verified)
    failures.push(`expected verified=${e.verified}, got ${run.verified}`);
  if (e.locked_out !== undefined && run.lockedOut !== e.locked_out)
    failures.push(`expected locked_out=${e.locked_out}, got ${run.lockedOut}`);
  if (e.final_language && run.language !== e.final_language)
    failures.push(`expected language ${e.final_language}, got ${run.language}`);

  for (const pattern of e.spoken_matching) {
    if (!new RegExp(pattern, "i").test(agentText))
      failures.push(`expected the agent to say /${pattern}/`);
  }
  for (const pattern of e.spoken_not_matching) {
    if (new RegExp(pattern, "i").test(agentText))
      failures.push(`agent said forbidden /${pattern}/`);
  }
  const beforeVerification = run.transcript
    .filter((l) => l.role === "agent" && !l.verified)
    .map((l) => l.text)
    .join("\n");
  for (const phrase of e.never_say_before_verification) {
    if (beforeVerification.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push(`PHI leak: "${phrase}" spoken before verification`);
    }
  }
  // Structural guarantee, checked on every script: no patient-data tool succeeded unverified.
  for (const t of run.tools) {
    if (t.ok && !t.verifiedAtCall && PATIENT_DATA_TOOLS.has(t.name))
      failures.push(`${t.name} succeeded before verification`);
  }

  const db = e.db;
  const checkCount = (label: string, actual: number, expected: Count | undefined) => {
    if (expected !== undefined && !matchesCount(actual, expected))
      failures.push(`expected ${label} ${expected}, got ${actual}`);
  };
  checkCount("voice_bookings", run.db.voiceBookings, db.voice_bookings);
  checkCount("cancelled_appointments", run.db.cancelledAppointments, db.cancelled_appointments);
  checkCount("callback_tasks", run.db.callbackTasks, db.callback_tasks);
  checkCount("review_tasks", run.db.reviewTasks, db.review_tasks);
  checkCount("sms_sent", run.db.smsSent, db.sms_sent);
  if (db.screening_status && run.db.screeningStatus !== db.screening_status) {
    failures.push(`expected screening ${db.screening_status}, got ${run.db.screeningStatus}`);
  }
  if (
    db.screening_words_contain &&
    !run.db.screeningWords.some((w) =>
      w.toLowerCase().includes(db.screening_words_contain!.toLowerCase()),
    )
  ) {
    failures.push(`expected screening answers to keep "${db.screening_words_contain}" verbatim`);
  }
  if (db.sms_language && !run.db.smsLanguages.includes(db.sms_language))
    failures.push(`expected an SMS in ${db.sms_language}`);
  if (run.db.screeningStatus === "clear") failures.push("screening was set to clear by the agent");
  return failures;
}

const PATIENT_DATA_TOOLS = new Set([
  "find_appointments",
  "search_slots",
  "hold_slot",
  "book_slot",
  "cancel_appointment",
  "record_screening_answer",
  "send_prep_instructions",
]);
