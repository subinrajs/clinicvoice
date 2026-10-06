/**
 * Demo activity layered on top of the base seed: a day of realistic calls (transcripts, tool
 * calls, latencies, post-call summaries), flagged MRI screenings, staff tasks, a voice-booked
 * reschedule, a prep text, usage and audit rows. Lets the dashboard tell the product's story
 * before any real call has been made. All synthetic.
 */
import { sql, type Transaction } from "kysely";
import type { Database } from "./schema.js";
import { zonedWallTimeToUtc } from "./time.js";

type Trx = Transaction<Database>;
type Role = "caller" | "agent" | "tool" | "system";

interface Turn {
  role: Role;
  text?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  state: string;
  /** Agent turns only: caller-silence-to-first-audio, ms. */
  latency?: number;
}

const TIME_ZONE = process.env.CLINIC_TIMEZONE ?? "America/Toronto";
const SCREENING_RULES_VERSION = "screening-rules.v1";

const ok = (data: unknown) => ({ ok: true, data });
const err = (code: string, message: string) => ({ ok: false, error: { code, message } });

function speakable(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = get("minute");
  const day = Number(get("day"));
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  const clock = `${hour % 12 || 12}${minute === "00" ? "" : `:${minute}`}`;
  const period = hour < 12 ? "in the morning" : hour < 17 ? "in the afternoon" : "in the evening";
  return `${get("weekday")}, ${get("month")} ${day}${suffix} at ${clock} ${period}`;
}

/** Spreads today's calls across the clinic day so far (or the last few hours late at night). */
function callTimes(count: number): Date[] {
  const now = Date.now();
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE })
    .format(new Date())
    .split("-")
    .map(Number) as [number, number, number];
  const localMidnight = zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0 }, TIME_ZONE);
  const minutesSinceMidnight = Math.max(60, (now - localMidnight.getTime()) / 60_000);
  const span = Math.min(minutesSinceMidnight - 10, 10 * 60);
  return Array.from(
    { length: count },
    (_, i) => new Date(now - ((count - i) / count) * span * 60_000),
  );
}

async function patientByName(trx: Trx, first: string, last: string) {
  return trx
    .selectFrom("patients")
    .select(["id", "first_name", "last_name"])
    .where("first_name", "=", first)
    .where("last_name", "=", last)
    .executeTakeFirstOrThrow();
}

async function bookedAppointment(trx: Trx, patientId: string) {
  return trx
    .selectFrom("appointments as a")
    .innerJoin("slots as s", "s.id", "a.slot_id")
    .innerJoin("sites as site", "site.id", "s.site_id")
    .select([
      "a.id",
      "a.ref",
      "a.exam_code",
      "a.slot_id",
      "a.requisition_id",
      "a.contrast",
      "s.starts_at",
      "s.modality",
      "site.name as site_name",
    ])
    .where("a.patient_id", "=", patientId)
    .where("a.status", "=", "booked")
    .executeTakeFirstOrThrow();
}

async function insertCall(
  trx: Trx,
  call: {
    startedAt: Date;
    durationSec: number;
    patientId: string | null;
    language?: "en" | "fr";
    outcome: string;
    endReason: string;
    flagged?: boolean;
    summary: Record<string, unknown>;
    turns: Turn[];
  },
): Promise<string> {
  const latencies = call.turns
    .filter((t) => t.latency !== undefined)
    .map((t) => t.latency!)
    .sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null;
  const row = await trx
    .insertInto("calls")
    .values({
      twilio_sid: `CA-demo-${call.startedAt.getTime()}`,
      from_hash: `demo-${call.startedAt.getTime()}`,
      language: call.language ?? "en",
      started_at: call.startedAt,
      ended_at: new Date(call.startedAt.getTime() + call.durationSec * 1000),
      verified_patient_id: call.patientId,
      outcome: call.outcome,
      end_reason: call.endReason,
      flagged: call.flagged ?? false,
      median_latency_ms: median,
      summary: JSON.stringify({ ...call.summary, prompt_version: "call-summary.v1" }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const step = (call.durationSec * 1000) / Math.max(1, call.turns.length);
  await trx
    .insertInto("call_turns")
    .values(
      call.turns.map((t, i) => ({
        call_id: row.id,
        seq: i + 1,
        role: t.role,
        text: t.text ?? null,
        tool_name: t.tool ?? null,
        tool_input: t.input === undefined ? null : JSON.stringify(t.input),
        tool_result: t.result === undefined ? null : JSON.stringify(t.result),
        state: t.state,
        latency_ms: t.latency ?? null,
        created_at: new Date(call.startedAt.getTime() + i * step),
      })),
    )
    .execute();

  // Rough token accounting so the spend view has something real-looking behind it.
  await trx
    .insertInto("llm_usage")
    .values([
      {
        call_id: row.id,
        at: call.startedAt,
        purpose: "live_turn",
        model: "gpt-5.4-mini",
        input_tokens: 2400 * latencies.length,
        cached_input_tokens: 1800 * latencies.length,
        output_tokens: 45 * latencies.length,
      },
      {
        call_id: row.id,
        at: call.startedAt,
        purpose: "call_summary",
        model: "gpt-5.5",
        input_tokens: 900,
        cached_input_tokens: 0,
        output_tokens: 140,
      },
    ])
    .execute();
  return row.id;
}

async function audit(trx: Trx, callId: string, action: string, entity: string, entityId: string) {
  await trx
    .insertInto("audit_log")
    .values({ actor: `agent:call:${callId}`, action, entity, entity_id: entityId })
    .execute();
}

/**
 * Books roughly 60% of the next three days' slots for generated patients, so the schedule view
 * looks like a working clinic. Deterministic (hash of the slot id), and never touches the named
 * demo patients used by the scripted conversations.
 */
async function fillUpcomingSchedule(trx: Trx): Promise<void> {
  const pool = await trx
    .selectFrom("patients")
    .select("id")
    .where("last_name", "not in", ["Santos", "Tremblay", "Okafor", "Raman"])
    .orderBy("last_name")
    .execute();
  const slots = await trx
    .selectFrom("slots")
    .select(["id", "modality"])
    .where("status", "=", "open")
    .where("starts_at", ">", sql<Date>`now()`)
    .where("starts_at", "<", sql<Date>`now() + interval '3 days'`)
    .orderBy("starts_at")
    .execute();
  const exams = {
    MRI: [
      { code: "MRI_KNEE", contrast: false },
      { code: "MRI_BRAIN", contrast: true },
      { code: "MRI_LSPINE", contrast: false },
    ],
    CT: [
      { code: "CT_HEAD", contrast: false },
      { code: "CT_CHEST", contrast: false },
      { code: "CT_ABDO", contrast: true },
    ],
  } as const;
  const hash = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

  const chosen = slots.filter((s) => hash(s.id) % 100 < 60);
  for (const [i, slot] of chosen.entries()) {
    const patient = pool[i % pool.length]!;
    const options = exams[slot.modality as "MRI" | "CT"];
    const exam = options[hash(slot.id) % options.length]!;
    const requisition = await trx
      .insertInto("requisitions")
      .values({
        patient_id: patient.id,
        exam_code: exam.code,
        modality: slot.modality,
        contrast: exam.contrast,
        status: "scheduled",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("appointments")
      .values({
        ref: sql<string>`'A' || nextval('appointment_ref_seq')`,
        patient_id: patient.id,
        requisition_id: requisition.id,
        slot_id: slot.id,
        exam_code: exam.code,
        contrast: exam.contrast,
        status: "booked",
        // About one booking in six came in through the voice assistant.
        created_via: hash(slot.id) % 6 === 0 ? "voice" : "staff",
      })
      .execute();
    await trx.updateTable("slots").set({ status: "booked" }).where("id", "=", slot.id).execute();
  }
}

export async function seedDemoActivity(trx: Trx): Promise<Record<string, number>> {
  const times = callTimes(9);
  const maria = await patientByName(trx, "Maria", "Santos");
  const jean = await patientByName(trx, "Jean", "Tremblay");
  const david = await patientByName(trx, "David", "Okafor");
  const tech = await trx
    .selectFrom("staff_users")
    .select("id")
    .where("role", "=", "technologist")
    .executeTakeFirstOrThrow();

  // Two other MRI patients from the generated set, for screening scenarios.
  const otherMri = await trx
    .selectFrom("appointments as a")
    .innerJoin("patients as p", "p.id", "a.patient_id")
    .innerJoin("slots as s", "s.id", "a.slot_id")
    .select(["p.id", "p.first_name", "p.last_name"])
    .where("a.status", "=", "booked")
    .where("s.modality", "=", "MRI")
    .where("p.last_name", "not in", ["Santos", "Tremblay", "Okafor", "Raman"])
    .orderBy("s.starts_at")
    .limit(3)
    .execute();
  const [aisha, ben, carla] = otherMri;
  if (!aisha || !ben || !carla)
    throw new Error("Demo activity needs at least three generated MRI bookings");

  // 1. Maria reschedules her knee MRI (voice booking, old slot freed).
  const mariaAppt = await bookedAppointment(trx, maria.id);
  const newSlot = await trx
    .selectFrom("slots as s")
    .innerJoin("sites as site", "site.id", "s.site_id")
    .select(["s.id", "s.starts_at", "site.name as site_name"])
    .where("s.modality", "=", "MRI")
    .where("s.status", "=", "open")
    .where("s.starts_at", ">", sql<Date>`now() + interval '1 day'`)
    .where("s.id", "!=", mariaAppt.slot_id)
    .orderBy("s.starts_at")
    .executeTakeFirstOrThrow();
  const oldWhen = speakable(mariaAppt.starts_at);
  const newWhen = speakable(newSlot.starts_at);
  const call1 = await insertCall(trx, {
    startedAt: times[0]!,
    durationSec: 154,
    patientId: maria.id,
    outcome: "resolved",
    endReason: "hangup",
    summary: {
      intent: "reschedule",
      outcome: "resolved",
      actions: [`Rescheduled MRI knee to ${newWhen}`, "Texted English prep instructions"],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: false,
      flag_reason: null,
      summary: `Maria Santos moved her knee MRI from ${oldWhen} to ${newWhen} after confirming. Prep instructions were texted.`,
    },
    turns: [
      {
        role: "caller",
        text: "Hi, I need to move my MRI appointment to a different day.",
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "Sure, I can help with that. First, what's your last name?",
        state: "verify_identity",
        latency: 820,
      },
      {
        role: "caller",
        text: "Santos. Born March 12, 1984, and my phone ends in 0121.",
        state: "verify_identity",
      },
      { role: "agent", text: "One moment while I check.", state: "verify_identity", latency: 690 },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: "Santos", dob: "1984-03-12", phone_last4: "0121" },
        result: ok({ verified: true, first_name: "Maria" }),
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "find_appointments",
        input: {},
        result: ok({
          appointments: [
            {
              ref: "APPT1",
              exam: "MRI of the knee",
              modality: "MRI",
              site: mariaAppt.site_name,
              when: oldWhen,
            },
          ],
        }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: `Thanks, Maria. I see your MRI of the knee on ${oldWhen}. Let me check the schedule.`,
        state: "handle_task",
        latency: 1180,
      },
      {
        role: "tool",
        tool: "search_slots",
        input: { modality: "MRI" },
        result: ok({
          exam: "MRI of the knee",
          slots: [{ ref: "S1", site: newSlot.site_name, when: newWhen }],
        }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: `I have ${newWhen} at ${newSlot.site_name}. Would that work?`,
        state: "handle_task",
        latency: 1240,
      },
      { role: "caller", text: "Yes, that works.", state: "handle_task" },
      {
        role: "tool",
        tool: "hold_slot",
        input: { slot_ref: "S1" },
        result: ok({ held: true, held_for_minutes: 5 }),
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "propose_action",
        input: { tool: "book_slot", args: { slot_ref: "S1", appointment_ref: "APPT1" } },
        result: ok({
          read_back: `I'll move your MRI of the knee from ${oldWhen} to ${newWhen} at ${newSlot.site_name}. Is that right?`,
        }),
        state: "confirm_action",
      },
      {
        role: "agent",
        text: `I'll move your MRI of the knee from ${oldWhen} to ${newWhen} at ${newSlot.site_name}. Is that right?`,
        state: "confirm_action",
        latency: 960,
      },
      { role: "caller", text: "Yes.", state: "execute_tool" },
      {
        role: "tool",
        tool: "book_slot",
        input: { slot_ref: "S1", appointment_ref: "APPT1" },
        result: ok({ booked: true, appointment_ref: "APPT2", when: newWhen }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "You're all set. Would you like the preparation instructions by text?",
        state: "handle_task",
        latency: 1010,
      },
      { role: "caller", text: "Yes please, in English.", state: "handle_task" },
      {
        role: "tool",
        tool: "propose_action",
        input: {
          tool: "send_prep_instructions",
          args: { appointment_ref: "APPT2", language: "en" },
        },
        result: ok({
          read_back:
            "I'll text the preparation instructions for your MRI of the knee, in English, to the phone number on your file. Okay?",
        }),
        state: "confirm_action",
      },
      {
        role: "agent",
        text: "I'll text the preparation instructions for your MRI of the knee, in English, to the phone number on your file. Okay?",
        state: "confirm_action",
        latency: 870,
      },
      { role: "caller", text: "Okay.", state: "execute_tool" },
      {
        role: "tool",
        tool: "send_prep_instructions",
        input: { appointment_ref: "APPT2", language: "en" },
        result: ok({ sent: true }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "Sent. Is there anything else I can help with?",
        state: "handle_task",
        latency: 780,
      },
      { role: "caller", text: "No, that's everything. Thanks!", state: "handle_task" },
      {
        role: "agent",
        text: "You're welcome, Maria. Have a great day.",
        state: "handle_task",
        latency: 640,
      },
    ],
  });
  await trx
    .updateTable("appointments")
    .set({ status: "cancelled", cancel_reason: "rescheduled" })
    .where("id", "=", mariaAppt.id)
    .execute();
  await trx
    .updateTable("slots")
    .set({ status: "open" })
    .where("id", "=", mariaAppt.slot_id)
    .execute();
  await trx.updateTable("slots").set({ status: "booked" }).where("id", "=", newSlot.id).execute();
  const newAppt = await trx
    .insertInto("appointments")
    .values({
      ref: sql<string>`'A' || nextval('appointment_ref_seq')`,
      patient_id: maria.id,
      requisition_id: mariaAppt.requisition_id,
      slot_id: newSlot.id,
      exam_code: mariaAppt.exam_code,
      contrast: mariaAppt.contrast,
      status: "booked",
      created_via: "voice",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const enTemplate = await trx
    .selectFrom("prep_templates")
    .select("id")
    .where("exam_code", "=", mariaAppt.exam_code)
    .where("language", "=", "en")
    .executeTakeFirstOrThrow();
  const msg1 = await trx
    .insertInto("messages")
    .values({
      patient_id: maria.id,
      template_id: enTemplate.id,
      channel: "sms",
      sent_at: times[0]!,
      provider_sid: "SM-demo-1",
      status: "delivered",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const [action, entity, id] of [
    ["verify", "patient", maria.id],
    ["read", "appointment", mariaAppt.id],
    ["book", "appointment", newAppt.id],
    ["cancel", "appointment", mariaAppt.id],
    ["send", "message", msg1.id],
  ] as const) {
    await audit(trx, call1, action, entity, id);
  }

  // 2. Parking question, no verification needed.
  await insertCall(trx, {
    startedAt: times[1]!,
    durationSec: 38,
    patientId: null,
    outcome: "resolved",
    endReason: "hangup",
    summary: {
      intent: "general_question",
      outcome: "resolved",
      actions: [],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: false,
      flag_reason: null,
      summary:
        "Caller asked about parking at Mississauga and was told it is free behind the building.",
    },
    turns: [
      {
        role: "caller",
        text: "Hi, where do I park at the Mississauga location?",
        state: "verify_identity",
      },
      {
        role: "tool",
        tool: "get_clinic_info",
        input: { site_code: "MISS" },
        result: ok({
          sites: [
            {
              code: "MISS",
              parking:
                "Free surface parking behind the building. Accessible spots by the main entrance.",
            },
          ],
        }),
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "Parking is free in the lot behind the building, with accessible spots by the main entrance. Anything else?",
        state: "verify_identity",
        latency: 910,
      },
      { role: "caller", text: "Perfect, that's all. Thanks.", state: "verify_identity" },
      { role: "agent", text: "You're welcome. Goodbye!", state: "verify_identity", latency: 600 },
    ],
  });

  // 3. Contrast and kidneys: no clinical answer, callback for the clinical team.
  const call3 = await insertCall(trx, {
    startedAt: times[2]!,
    durationSec: 71,
    patientId: david.id,
    outcome: "callback_needed",
    endReason: "hangup",
    summary: {
      intent: "medical_question",
      outcome: "callback_needed",
      actions: ["Created callback task for clinical team"],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: false,
      flag_reason: null,
      summary:
        "David Okafor asked whether CT contrast is safe with his kidney condition. The agent did not advise and created a callback.",
    },
    turns: [
      {
        role: "caller",
        text: "I have a CT with contrast coming up. Is the contrast safe for my kidneys? I have kidney disease.",
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "That's an important question for our clinical team. I can't advise on that, but I can have someone call you back. May I have your last name?",
        state: "verify_identity",
        latency: 1090,
      },
      {
        role: "caller",
        text: "Okafor, July 25, 1962, phone ending 0147.",
        state: "verify_identity",
      },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: "Okafor", dob: "1962-07-25", phone_last4: "0147" },
        result: ok({ verified: true, first_name: "David" }),
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "create_task",
        input: {
          type: "callback",
          reason: "Asks whether CT contrast is safe with kidney disease before CT abdomen",
        },
        result: ok({ task_ref: "T1", created: true }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "Thanks, David. A member of our clinical team will call you back about the contrast. Anything else?",
        state: "handle_task",
        latency: 1320,
      },
      { role: "caller", text: "No, thank you.", state: "handle_task" },
    ],
  });
  await trx
    .insertInto("tasks")
    .values({
      type: "callback",
      call_id: call3,
      patient_id: david.id,
      reason: "Asks whether CT contrast is safe with kidney disease before CT abdomen",
      assigned_role: "front_desk",
      status: "open",
      created_at: times[2]!,
    })
    .execute();
  await audit(trx, call3, "verify", "patient", david.id);

  // 4. Screening: pacemaker → needs_review, review task, extracted device.
  const aishaAppt = await bookedAppointment(trx, aisha.id);
  const call4 = await insertCall(trx, {
    startedAt: times[3]!,
    durationSec: 186,
    patientId: aisha.id,
    outcome: "resolved",
    endReason: "hangup",
    summary: {
      intent: "screening",
      outcome: "resolved",
      actions: ["Completed MRI safety questionnaire", "Flagged pacemaker for technologist review"],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: false,
      flag_reason: null,
      summary: `${aisha.first_name} ${aisha.last_name} completed MRI screening and reported a pacemaker; flagged for technologist review.`,
    },
    turns: [
      {
        role: "caller",
        text: "I got a message to do the safety questions for my MRI.",
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "Happy to help. First, what's your last name?",
        state: "verify_identity",
        latency: 760,
      },
      {
        role: "caller",
        text: `${aisha.last_name}. I can give you my birthday and phone too.`,
        state: "verify_identity",
      },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: aisha.last_name, dob: "on file", phone_last4: "on file" },
        result: ok({ verified: true, first_name: aisha.first_name }),
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "record_screening_answer",
        input: { appointment_ref: "APPT1" },
        result: ok({
          next_question: { id: "pacemaker", ask: "Do you have a pacemaker or defibrillator?" },
        }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "Thanks. First question: do you have a pacemaker or defibrillator?",
        state: "handle_task",
        latency: 1150,
      },
      {
        role: "caller",
        text: "Yes, I have a pacemaker. I got it in 2021, I think it's a Medtronic.",
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "record_screening_answer",
        input: {
          appointment_ref: "APPT1",
          question_id: "pacemaker",
          answer: "yes",
          caller_words: "Yes, I have a pacemaker. I got it in 2021, I think it's a Medtronic.",
        },
        result: ok({
          next_question: {
            id: "neurostimulator",
            ask: "Do you have a neurostimulator, cochlear implant or any implanted pump?",
          },
        }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "Thank you for telling me. I've noted that for our technologist. Do you have a neurostimulator, cochlear implant or any implanted pump?",
        state: "handle_task",
        latency: 1060,
      },
      { role: "caller", text: "No.", state: "handle_task" },
      {
        role: "agent",
        text: "Thanks. That's all the questions. A technologist will review your answers before your visit and may call you.",
        state: "handle_task",
        latency: 980,
      },
    ],
  });
  const scr4 = await trx
    .insertInto("screenings")
    .values({
      appointment_id: aishaAppt.id,
      rules_version: SCREENING_RULES_VERSION,
      status: "needs_review",
      answers: JSON.stringify({
        pacemaker: {
          answer: "yes",
          callerWords: "Yes, I have a pacemaker. I got it in 2021, I think it's a Medtronic.",
          at: times[3]!.toISOString(),
        },
        neurostimulator: { answer: "no", callerWords: null, at: times[3]!.toISOString() },
        aneurysm_clip: { answer: "no", callerWords: null, at: times[3]!.toISOString() },
        metal_fragments: { answer: "no", callerWords: null, at: times[3]!.toISOString() },
        implants_other: { answer: "no", callerWords: null, at: times[3]!.toISOString() },
      }),
      implants: JSON.stringify([
        {
          device: "Cardiac pacemaker (possibly Medtronic, implanted 2021)",
          bodyLocation: "chest",
          callerWords: "I have a pacemaker. I got it in 2021, I think it's a Medtronic.",
          needsFollowUp: true,
          questionId: "pacemaker",
        },
      ]),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("tasks")
    .values({
      type: "review",
      call_id: call4,
      patient_id: aisha.id,
      screening_id: scr4.id,
      reason: 'MRI screening flagged on "pacemaker". Technologist review required before the scan.',
      assigned_role: "technologist",
      created_at: times[3]!,
    })
    .execute();
  await audit(trx, call4, "update", "screening", scr4.id);

  // 5. Screening: "not sure, I had knee surgery" → needs_review, verbatim words kept.
  const benAppt = await bookedAppointment(trx, ben.id);
  const call5 = await insertCall(trx, {
    startedAt: times[4]!,
    durationSec: 212,
    patientId: ben.id,
    outcome: "resolved",
    endReason: "hangup",
    summary: {
      intent: "screening",
      outcome: "resolved",
      actions: [
        "Completed MRI safety questionnaire",
        "Recorded possible orthopedic hardware for review",
      ],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: false,
      flag_reason: null,
      summary: `${ben.first_name} ${ben.last_name} was unsure about hardware from a past knee surgery; recorded verbatim and flagged for review.`,
    },
    turns: [
      {
        role: "caller",
        text: "Hi, I need to do the MRI screening questions.",
        state: "verify_identity",
      },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: ben.last_name, dob: "on file", phone_last4: "on file" },
        result: ok({ verified: true, first_name: ben.first_name }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "Do you have any other implants, such as joint replacements, plates, screws or stents?",
        state: "handle_task",
        latency: 1210,
      },
      {
        role: "caller",
        text: "I'm not sure, I had knee surgery a few years ago. They might have put something in.",
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "record_screening_answer",
        input: {
          appointment_ref: "APPT1",
          question_id: "implants_other",
          answer: "unsure",
          caller_words:
            "I'm not sure, I had knee surgery a few years ago. They might have put something in.",
        },
        result: ok({
          next_question: { id: "pregnant", ask: "Is there any chance you are pregnant?" },
        }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "That's okay, I've noted it exactly as you said for our technologist. Is there any chance you are pregnant?",
        state: "handle_task",
        latency: 1090,
      },
      { role: "caller", text: "No.", state: "handle_task" },
      {
        role: "agent",
        text: "Thank you. A technologist will review your answers before your visit.",
        state: "handle_task",
        latency: 870,
      },
    ],
  });
  const scr5 = await trx
    .insertInto("screenings")
    .values({
      appointment_id: benAppt.id,
      rules_version: SCREENING_RULES_VERSION,
      status: "needs_review",
      answers: JSON.stringify({
        pacemaker: { answer: "no", callerWords: null, at: times[4]!.toISOString() },
        neurostimulator: { answer: "no", callerWords: null, at: times[4]!.toISOString() },
        aneurysm_clip: { answer: "no", callerWords: null, at: times[4]!.toISOString() },
        metal_fragments: { answer: "no", callerWords: null, at: times[4]!.toISOString() },
        implants_other: {
          answer: "unsure",
          callerWords:
            "I'm not sure, I had knee surgery a few years ago. They might have put something in.",
          at: times[4]!.toISOString(),
        },
        pregnant: { answer: "no", callerWords: null, at: times[4]!.toISOString() },
      }),
      implants: JSON.stringify([
        {
          device: "Unknown hardware from prior knee surgery",
          bodyLocation: "knee",
          callerWords: "I had knee surgery a few years ago. They might have put something in.",
          needsFollowUp: true,
          questionId: "implants_other",
        },
      ]),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("tasks")
    .values({
      type: "review",
      call_id: call5,
      patient_id: ben.id,
      screening_id: scr5.id,
      reason:
        'MRI screening flagged on "implants_other". Technologist review required before the scan.',
      assigned_role: "technologist",
      status: "in_progress",
      created_at: times[4]!,
    })
    .execute();

  // A screening the technologist already cleared earlier today, and one still in progress.
  const carlaAppt = await bookedAppointment(trx, carla.id);
  const scr6 = await trx
    .insertInto("screenings")
    .values({
      appointment_id: carlaAppt.id,
      rules_version: SCREENING_RULES_VERSION,
      status: "clear",
      answers: JSON.stringify({
        implants_other: {
          answer: "yes",
          callerWords: "I have a titanium hip replacement from 2018.",
          at: times[0]!.toISOString(),
        },
      }),
      implants: JSON.stringify([
        {
          device: "Titanium hip replacement (2018)",
          bodyLocation: "hip",
          callerWords: "I have a titanium hip replacement from 2018.",
          needsFollowUp: false,
          questionId: "implants_other",
        },
      ]),
      reviewed_by: tech.id,
      reviewed_at: times[1]!,
      review_note:
        "Titanium hip prosthesis is MR-conditional at 1.5T. Cleared; scan on the 1.5T unit.",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("tasks")
    .values({
      type: "review",
      patient_id: carla.id,
      screening_id: scr6.id,
      reason:
        'MRI screening flagged on "implants_other". Technologist review required before the scan.',
      assigned_role: "technologist",
      status: "done",
      created_at: times[0]!,
    })
    .execute();
  await trx
    .insertInto("audit_log")
    .values({
      actor: `staff:${tech.id}`,
      action: "review",
      entity: "screening",
      entity_id: scr6.id,
    })
    .execute();

  // 6. Identity fails three times → locked, flagged, callback.
  const call6 = await insertCall(trx, {
    startedAt: times[5]!,
    durationSec: 97,
    patientId: null,
    outcome: "identity_failed",
    endReason: "hangup",
    flagged: true,
    summary: {
      intent: "other",
      outcome: "identity_failed",
      actions: ["Created callback task"],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: true,
      flag_reason: "Three failed identity checks for the same patient record.",
      summary:
        "Caller could not verify identity after three attempts; no patient information was shared and a callback was offered.",
    },
    turns: [
      {
        role: "caller",
        text: "I want to check my appointment. Santos, March 13, 1984, phone ending 0121.",
        state: "verify_identity",
      },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: "Santos", dob: "1984-03-13", phone_last4: "0121" },
        result: err("NO_MATCH", "Details did not match. Attempts remaining: 2."),
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "I'm sorry, I couldn't match those details. Could you repeat them?",
        state: "verify_identity",
        latency: 940,
      },
      { role: "caller", text: "March 14, 1984.", state: "verify_identity" },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: "Santos", dob: "1984-03-14", phone_last4: "0121" },
        result: err("NO_MATCH", "Details did not match. Attempts remaining: 1."),
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "I'm still unable to match those details. One more try?",
        state: "verify_identity",
        latency: 880,
      },
      { role: "caller", text: "March 15.", state: "verify_identity" },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: "Santos", dob: "1984-03-15", phone_last4: "0121" },
        result: err("LOCKED", "Third failed attempt. Offer a staff callback."),
        state: "escalate",
      },
      {
        role: "tool",
        tool: "create_task",
        input: { type: "callback", reason: "Caller failed identity verification three times" },
        result: ok({ task_ref: "T1", created: true }),
        state: "escalate",
      },
      {
        role: "agent",
        text: "I'm sorry, I can't verify your identity by phone. A team member will call you back to help.",
        state: "escalate",
        latency: 1030,
      },
    ],
  });
  await trx
    .insertInto("tasks")
    .values({
      type: "callback",
      call_id: call6,
      reason: "Caller failed identity verification three times",
      assigned_role: "front_desk",
      created_at: times[5]!,
    })
    .execute();

  // 7. French caller asks for prep instructions; sent in French.
  const jeanAppt = await bookedAppointment(trx, jean.id);
  const jeanWhen = speakable(jeanAppt.starts_at);
  const call7 = await insertCall(trx, {
    startedAt: times[6]!,
    durationSec: 118,
    patientId: jean.id,
    language: "fr",
    outcome: "resolved",
    endReason: "hangup",
    summary: {
      intent: "prep_instructions",
      outcome: "resolved",
      actions: ["Texted French prep instructions for MRI brain with contrast"],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: false,
      flag_reason: null,
      summary:
        "Jean Tremblay called in French and received the approved French prep instructions for his brain MRI by text.",
    },
    turns: [
      {
        role: "caller",
        text: "Bonjour, en français s'il vous plaît. Je voudrais les instructions de préparation pour mon IRM.",
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "Bien sûr. Quel est votre nom de famille?",
        state: "verify_identity",
        latency: 890,
      },
      {
        role: "caller",
        text: "Tremblay, né le 2 novembre 1979, numéro se terminant par 0134.",
        state: "verify_identity",
      },
      {
        role: "tool",
        tool: "verify_identity",
        input: { last_name: "Tremblay", dob: "1979-11-02", phone_last4: "0134" },
        result: ok({ verified: true, first_name: "Jean" }),
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "find_appointments",
        input: {},
        result: ok({
          appointments: [
            {
              ref: "APPT1",
              exam: "IRM du cerveau avec contraste",
              modality: "MRI",
              site: jeanAppt.site_name,
              when: jeanWhen,
            },
          ],
        }),
        state: "handle_task",
      },
      {
        role: "tool",
        tool: "propose_action",
        input: {
          tool: "send_prep_instructions",
          args: { appointment_ref: "APPT1", language: "fr" },
        },
        result: ok({
          read_back:
            "Je vous envoie par texto les instructions de préparation pour votre IRM du cerveau avec contraste, en français, au numéro inscrit à votre dossier. D'accord?",
        }),
        state: "confirm_action",
      },
      {
        role: "agent",
        text: "Je vous envoie par texto les instructions de préparation pour votre IRM du cerveau avec contraste, en français, au numéro inscrit à votre dossier. D'accord?",
        state: "confirm_action",
        latency: 1270,
      },
      { role: "caller", text: "Oui, merci.", state: "execute_tool" },
      {
        role: "tool",
        tool: "send_prep_instructions",
        input: { appointment_ref: "APPT1", language: "fr" },
        result: ok({ sent: true }),
        state: "handle_task",
      },
      {
        role: "agent",
        text: "C'est envoyé. Puis-je vous aider avec autre chose?",
        state: "handle_task",
        latency: 820,
      },
      { role: "caller", text: "Non merci, c'est tout.", state: "handle_task" },
      {
        role: "agent",
        text: "Merci de votre appel. Bonne journée!",
        state: "handle_task",
        latency: 610,
      },
    ],
  });
  const frTemplate = await trx
    .selectFrom("prep_templates")
    .select("id")
    .where("exam_code", "=", jeanAppt.exam_code)
    .where("language", "=", "fr")
    .executeTakeFirstOrThrow();
  const msg7 = await trx
    .insertInto("messages")
    .values({
      patient_id: jean.id,
      template_id: frTemplate.id,
      channel: "sms",
      sent_at: times[6]!,
      provider_sid: "SM-demo-2",
      status: "delivered",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await audit(trx, call7, "send", "message", msg7.id);

  // 8. Caller asks for a person; transfer not answered → transfer_failed task.
  const call8 = await insertCall(trx, {
    startedAt: times[7]!,
    durationSec: 64,
    patientId: null,
    outcome: "transferred",
    endReason: "transfer",
    summary: {
      intent: "other",
      outcome: "transferred",
      actions: ["Warm transfer to front desk (not answered)", "Created transfer-failed task"],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: false,
      flag_reason: null,
      summary:
        "Caller asked to speak with a person about a billing letter; transfer was attempted and a callback task created when unanswered.",
    },
    turns: [
      {
        role: "caller",
        text: "Can I just talk to a real person? It's about a letter I got.",
        state: "verify_identity",
      },
      {
        role: "tool",
        tool: "transfer_to_staff",
        input: {
          reason: "caller_request",
          summary: "Caller wants to discuss a letter they received",
        },
        result: ok({ transferring: true }),
        state: "escalate",
      },
      {
        role: "agent",
        text: "Of course. I'll connect you with our team now.",
        state: "escalate",
        latency: 720,
      },
    ],
  });
  await trx
    .insertInto("tasks")
    .values({
      type: "transfer_failed",
      call_id: call8,
      reason: "Warm transfer not answered (no-answer)",
      assigned_role: "front_desk",
      created_at: times[7]!,
    })
    .execute();

  // 9. The output filter catches a risky sentence; the call is flagged for review.
  const call9 = await insertCall(trx, {
    startedAt: times[8]!,
    durationSec: 83,
    patientId: null,
    outcome: "callback_needed",
    endReason: "hangup",
    flagged: true,
    summary: {
      intent: "medical_question",
      outcome: "callback_needed",
      actions: ["Output filter replaced one reply", "Created callback task"],
      follow_up_needed: false,
      follow_up_reason: null,
      flag_for_review: true,
      flag_reason: "Output filter replaced a reply about fasting before a CT.",
      summary:
        "Caller asked whether they can take their diabetes medication before a fasting CT. The output filter replaced the draft reply with an escalation line.",
    },
    turns: [
      {
        role: "caller",
        text: "I have to fast for my CT. Can I still take my diabetes pills that morning?",
        state: "verify_identity",
      },
      { role: "system", text: "output_filter_hit", state: "verify_identity" },
      {
        role: "agent",
        text: "I'm not able to advise on that, but I can have a member of our clinical team call you back.",
        state: "verify_identity",
        latency: 1380,
      },
      { role: "caller", text: "Okay, please do.", state: "verify_identity" },
      {
        role: "tool",
        tool: "create_task",
        input: {
          type: "callback",
          reason: "Asks about taking diabetes medication while fasting before CT",
        },
        result: ok({ task_ref: "T1", created: true }),
        state: "verify_identity",
      },
      {
        role: "agent",
        text: "Done. Someone from our clinical team will call you back today. Anything else?",
        state: "verify_identity",
        latency: 990,
      },
    ],
  });
  await trx
    .insertInto("tasks")
    .values({
      type: "callback",
      call_id: call9,
      reason: "Asks about taking diabetes medication while fasting before CT",
      assigned_role: "front_desk",
      created_at: times[8]!,
    })
    .execute();

  await fillUpcomingSchedule(trx);

  const counts = await trx
    .selectFrom("calls")
    .select([
      sql<string>`count(*)`.as("calls"),
      sql<string>`(select count(*) from tasks)`.as("tasks"),
      sql<string>`(select count(*) from screenings)`.as("screenings"),
    ])
    .executeTakeFirstOrThrow();
  return {
    demoCalls: Number(counts.calls),
    demoTasks: Number(counts.tasks),
    demoScreenings: Number(counts.screenings),
  };
}
