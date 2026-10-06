import pino from "pino";
import type { ChatModel, ModelTurnRequest } from "../src/llm/types.js";
import type { AuditEvent, AuditWriter } from "../src/repositories/auditRepository.js";
import type {
  ClinicRepository,
  IdentityCandidate,
  SiteInfo,
  UpcomingAppointment,
} from "../src/repositories/clinicRepository.js";
import { createCallSession, type CallSession } from "../src/session/callSession.js";
import { createToolRegistry } from "../src/tools/registry.js";
import type { ToolContext, ToolDefinition } from "../src/tools/types.js";
import type { JobPayload, JobQueue, JobType } from "../src/jobs/jobQueue.js";
import type { MessagingPort, PrepTemplate } from "../src/messaging/messagingRepository.js";
import { RecordingSmsSender } from "../src/messaging/smsSender.js";
import type {
  BookInput,
  PatientAppointment,
  Requisition,
  RisResult,
  SchedulingPort,
  SlotView,
} from "../src/repositories/risRepository.js";
import type {
  ImplantEntry,
  RecordedAnswer,
  Screening,
  ScreeningPort,
} from "../src/repositories/screeningRepository.js";

export const silentLogger = pino({ level: "silent" });

export const MARIA: IdentityCandidate = {
  id: "p-maria",
  firstName: "Maria",
  lastName: "Santos",
  preferredLanguage: "en",
};

export class FakeClinicRepository implements ClinicRepository {
  patients: (IdentityCandidate & { dob: string; last4: string })[] = [
    { ...MARIA, dob: "1984-03-12", last4: "0121" },
  ];
  failures: { patientId: string | null; fromHash: string | null; callId: string }[] = [];
  priorFailures = 0;
  appointments: UpcomingAppointment[] = [
    {
      id: "appt-1",
      ref: "A1001",
      examCode: "MRI_KNEE",
      modality: "MRI",
      siteName: "Lakeshore MRI & CT Mississauga",
      startsAt: new Date("2026-10-15T18:40:00Z"),
    },
  ];
  tasks: { type: string; reason: string; patientId: string | null; screeningId?: string }[] = [];
  verifiedCalls: string[] = [];

  async listSites(): Promise<SiteInfo[]> {
    return [
      {
        code: "MISS",
        name: "Mississauga",
        address: "2150 Lakeshore Rd W",
        modalities: ["MRI", "CT"],
        hours: {
          "1": "07:00-21:00",
          "2": "07:00-21:00",
          "3": "07:00-21:00",
          "4": "07:00-21:00",
          "5": "07:00-21:00",
          "6": "08:00-16:00",
          "7": null,
        },
        parking: "Free lot.",
      },
    ];
  }
  async findIdentityCandidates(dob: string, last4: string) {
    return this.patients.filter((p) => p.dob === dob && p.last4 === last4);
  }
  async countRecentIdentityFailures() {
    return this.priorFailures + this.failures.length;
  }
  async recordIdentityFailure(entry: {
    patientId: string | null;
    fromHash: string | null;
    callId: string;
  }) {
    this.failures.push(entry);
  }
  async markCallVerified(callId: string) {
    this.verifiedCalls.push(callId);
  }
  async listUpcomingAppointments() {
    return this.appointments;
  }
  async createTask(task: {
    type: string;
    reason: string;
    patientId: string | null;
    screeningId?: string;
  }) {
    this.tasks.push(task);
    return { id: `task-${this.tasks.length}` };
  }
}

export class FakeAuditWriter implements AuditWriter {
  events: AuditEvent[] = [];
  async write(event: AuditEvent) {
    this.events.push(event);
  }
}

/** In-memory RIS: one MRI appointment for Maria, an MRI requisition, and a few open slots. */
export class FakeScheduling implements SchedulingPort {
  slots: (SlotView & { status: "open" | "held" | "booked"; heldBy: string | null })[] = [
    {
      id: "slot-1",
      siteCode: "MISS",
      siteName: "Lakeshore MRI & CT Mississauga",
      modality: "MRI",
      startsAt: new Date("2026-10-15T13:00:00Z"),
      durationMin: 45,
      status: "open",
      heldBy: null,
    },
    {
      id: "slot-2",
      siteCode: "MISS",
      siteName: "Lakeshore MRI & CT Mississauga",
      modality: "MRI",
      startsAt: new Date("2026-10-16T18:40:00Z"),
      durationMin: 45,
      status: "open",
      heldBy: null,
    },
    {
      id: "slot-3",
      siteCode: "TOR",
      siteName: "Lakeshore MRI & CT Toronto Downtown",
      modality: "MRI",
      startsAt: new Date("2026-10-17T22:00:00Z"),
      durationMin: 45,
      status: "open",
      heldBy: null,
    },
  ];
  appointments: (PatientAppointment & { patientId: string })[] = [
    {
      id: "appt-1",
      patientId: "p-maria",
      examCode: "MRI_KNEE",
      contrast: false,
      modality: "MRI",
      siteName: "Lakeshore MRI & CT Mississauga",
      startsAt: new Date("2026-10-15T18:40:00Z"),
      status: "booked",
      requisitionId: "req-1",
    },
  ];
  requisitions: (Requisition & { patientId: string })[] = [
    {
      id: "req-1",
      patientId: "p-maria",
      examCode: "MRI_KNEE",
      modality: "MRI",
      contrast: false,
      status: "scheduled",
    },
  ];
  bookings: BookInput[] = [];
  cancellations: string[] = [];

  async searchSlots(q: {
    modality: string;
    siteCode?: string;
    from: Date;
    to: Date;
    limit?: number;
  }) {
    return this.slots
      .filter(
        (s) =>
          s.status === "open" &&
          s.modality === q.modality &&
          (!q.siteCode || s.siteCode === q.siteCode) &&
          s.startsAt >= q.from &&
          s.startsAt < q.to,
      )
      .slice(0, q.limit ?? 5);
  }
  async getSlot(id: string) {
    return this.slots.find((s) => s.id === id);
  }
  async holdSlot(id: string, callId: string | null): Promise<RisResult<{ heldUntil: Date }>> {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot || slot.status !== "open") return { ok: false, reason: "SLOT_TAKEN" };
    slot.status = "held";
    slot.heldBy = callId;
    return { ok: true, value: { heldUntil: new Date("2026-10-05T14:05:00Z") } };
  }
  async releaseHold(id: string) {
    const slot = this.slots.find((s) => s.id === id);
    if (slot?.status === "held") Object.assign(slot, { status: "open", heldBy: null });
  }
  async bookSlot(
    input: BookInput,
  ): Promise<RisResult<{ appointmentId: string; ref: string; startsAt: Date }>> {
    const slot = this.slots.find((s) => s.id === input.slotId);
    if (!slot || slot.status !== "held" || slot.heldBy !== input.heldByCall)
      return { ok: false, reason: "HOLD_EXPIRED" };
    slot.status = "booked";
    this.bookings.push(input);
    if (input.replacesAppointmentId) this.cancellations.push(input.replacesAppointmentId);
    const id = `appt-new-${this.bookings.length}`;
    this.appointments.push({
      id,
      patientId: input.patientId,
      examCode: input.examCode,
      contrast: input.contrast,
      modality: slot.modality,
      siteName: slot.siteName,
      startsAt: slot.startsAt,
      status: "booked",
      requisitionId: input.requisitionId,
    });
    return {
      ok: true,
      value: { appointmentId: id, ref: `A50${this.bookings.length}`, startsAt: slot.startsAt },
    };
  }
  async cancelAppointment(id: string, patientId: string): Promise<RisResult<{ cancelled: true }>> {
    const appt = this.appointments.find((a) => a.id === id && a.patientId === patientId);
    if (!appt) return { ok: false, reason: "NOT_FOUND" };
    appt.status = "cancelled";
    this.cancellations.push(id);
    return { ok: true, value: { cancelled: true } };
  }
  async getPatientAppointment(patientId: string, id: string) {
    return this.appointments.find((a) => a.id === id && a.patientId === patientId);
  }
  async findRequisition(patientId: string, modality: string) {
    return this.requisitions.find((r) => r.patientId === patientId && r.modality === modality);
  }
}

export class FakeScreening implements ScreeningPort {
  screenings = new Map<string, Screening>();
  async getOrCreate(appointmentId: string, rulesVersion: string) {
    const existing = [...this.screenings.values()].find((s) => s.appointmentId === appointmentId);
    if (existing) return structuredClone(existing);
    const created: Screening = {
      id: `scr-${appointmentId}`,
      appointmentId,
      answers: {},
      implants: [],
      rulesVersion,
      status: "in_progress",
    };
    this.screenings.set(created.id, created);
    return structuredClone(created);
  }
  async saveAnswers(
    id: string,
    answers: Record<string, RecordedAnswer>,
    status: Screening["status"],
  ) {
    const s = this.screenings.get(id)!;
    Object.assign(s, { answers: structuredClone(answers), status });
  }
  async saveImplants(id: string, implants: ImplantEntry[]) {
    this.screenings.get(id)!.implants = implants;
  }
}

export class FakeMessaging implements MessagingPort {
  templates: (PrepTemplate & { examCode: string; language: string })[] = [
    { id: "tpl-en", examCode: "MRI_KNEE", language: "en", body: "Knee MRI prep (EN)", version: 1 },
    {
      id: "tpl-fr",
      examCode: "MRI_KNEE",
      language: "fr",
      body: "Préparation IRM genou (FR)",
      version: 1,
    },
  ];
  messages: { patientId: string; templateId: string }[] = [];
  async findApprovedTemplate(examCode: string, language: string) {
    return this.templates.find((t) => t.examCode === examCode && t.language === language);
  }
  async getPatientPhone() {
    return "+14165550121";
  }
  async recordMessage(entry: { patientId: string; templateId: string }) {
    this.messages.push(entry);
    return { id: `msg-${this.messages.length}` };
  }
}

export class FakeJobQueue implements JobQueue {
  jobs: { type: JobType; payload: unknown }[] = [];
  async enqueue<T extends JobType>(type: T, payload: JobPayload<T>) {
    this.jobs.push({ type, payload });
  }
}

export interface Fakes {
  repo: FakeClinicRepository;
  scheduling: FakeScheduling;
  screening: FakeScreening;
  messaging: FakeMessaging;
  sms: RecordingSmsSender;
  jobs: FakeJobQueue;
  audit: FakeAuditWriter;
}

export function createFakes(): Fakes {
  return {
    repo: new FakeClinicRepository(),
    scheduling: new FakeScheduling(),
    screening: new FakeScreening(),
    messaging: new FakeMessaging(),
    sms: new RecordingSmsSender(),
    jobs: new FakeJobQueue(),
    audit: new FakeAuditWriter(),
  };
}

/** Tool context minus the registry, as AgentDeps.toolContext returns it. */
export function baseContext(
  session: CallSession,
  fakes: Fakes,
  options: { transferAvailable?: boolean } = {},
): Omit<ToolContext, "tools"> {
  return {
    session,
    ...fakes,
    transferAvailable: options.transferAvailable ?? false,
    logger: silentLogger,
    timeZone: "America/Toronto",
    now: () => new Date("2026-10-05T14:00:00Z"),
    requestId: "req-1",
  };
}

export function makeContext(
  options: {
    session?: CallSession;
    tools?: ReadonlyMap<string, ToolDefinition>;
    transferAvailable?: boolean;
  } = {},
) {
  const fakes = createFakes();
  const session =
    options.session ??
    createCallSession({ callId: "call-1", callSid: "CA123", fromHash: "hash-1" });
  const tools = options.tools ?? createToolRegistry();
  const ctx: ToolContext = { ...baseContext(session, fakes, options), tools };
  return { ctx, session, tools, ...fakes };
}

export function verify(session: CallSession, patientId = MARIA.id) {
  session.verifiedPatientId = patientId;
  session.verifiedFirstName = "Maria";
}

/** A scripted model response: optional spoken text, optional tool calls. */
export interface ScriptedReply {
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

/**
 * Scripted ChatModel: replays replies in order, streaming text in small chunks the way a real
 * provider does, and records each request so tests can assert on what the model was sent.
 */
export function fakeChatModel(replies: ScriptedReply[]) {
  const requests: Omit<ModelTurnRequest, "onText" | "signal">[] = [];
  let index = 0;
  const model: ChatModel = {
    provider: "fake",
    model: "fake-model",
    async streamTurn(request) {
      const { onText, signal: _signal, ...recorded } = request;
      requests.push(structuredClone(recorded));
      const reply = replies[index++];
      if (!reply) throw new Error(`No scripted reply for request #${index}`);
      for (const chunk of reply.text?.match(/.{1,7}/gs) ?? []) onText(chunk);
      const toolCalls = (reply.tools ?? []).map((t, i) => ({
        id: `call_${index}_${i}`,
        name: t.name,
        input: t.input,
      }));
      return {
        text: reply.text ?? "",
        toolCalls,
        stopReason: toolCalls.length ? "tool_calls" : "end",
        ...(reply.usage ? { usage: reply.usage } : {}),
      };
    },
  };
  return { model, requests };
}
