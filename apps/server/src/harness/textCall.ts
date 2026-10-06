import type { Db } from "@clinicvoice/db";
import { randomUUID } from "node:crypto";
import { runAgentTurn, type TurnRecord } from "../agent/agent.js";
import type { Logger } from "../lib/logger.js";
import type { ChatModel } from "../llm/types.js";
import { PostgresMessagingRepository } from "../messaging/messagingRepository.js";
import { RecordingSmsSender } from "../messaging/smsSender.js";
import { PostgresJobQueue } from "../jobs/jobQueue.js";
import { PostgresAuditWriter } from "../repositories/auditRepository.js";
import { PostgresCallRepository } from "../repositories/callRepository.js";
import { PostgresClinicRepository } from "../repositories/clinicRepository.js";
import { RisRepository } from "../repositories/risRepository.js";
import { PostgresScreeningRepository } from "../repositories/screeningRepository.js";
import { createCallSession, type CallSession } from "../session/callSession.js";
import { createToolRegistry } from "../tools/registry.js";
import type { RunObservation, ToolEvent, TranscriptLine } from "./assertions.js";

const FRENCH_REQUEST = /\b(fran[cç]ais|french)\b/i;

export interface TextCallDeps {
  db: Db;
  model: ChatModel;
  systemPrompt: string;
  logger: Logger;
  timeZone: string;
}

/**
 * The text-mode harness: the real call session, agent loop, tools and database, driven by typed
 * caller turns instead of audio. Mirrors the relay's language switch and turn persistence.
 */
export class TextCall {
  readonly sms = new RecordingSmsSender();
  readonly tools: ToolEvent[] = [];
  readonly transcript: TranscriptLine[] = [];
  private session!: CallSession;
  private readonly calls: PostgresCallRepository;

  constructor(private readonly deps: TextCallDeps) {
    this.calls = new PostgresCallRepository(deps.db, deps.logger);
  }

  async start(): Promise<void> {
    const { id } = await this.calls.startCall({
      twilioSid: `TEXT-${randomUUID()}`,
      fromHash: `harness-${randomUUID()}`,
    });
    this.session = createCallSession({ callId: id, callSid: `TEXT-${id}`, fromHash: null });
  }

  get callId(): string {
    return this.session.callId;
  }

  async say(text: string): Promise<string> {
    const { db } = this.deps;
    const session = this.session;
    if (FRENCH_REQUEST.test(text)) session.language = "fr";
    this.transcript.push({ role: "caller", text, verified: Boolean(session.verifiedPatientId) });
    const spoken: string[] = [];
    const clinic = new PostgresClinicRepository(db);

    await runAgentTurn(
      {
        model: this.deps.model,
        systemPrompt: this.deps.systemPrompt,
        tools: createToolRegistry(),
        logger: this.deps.logger,
        toolContext: (s) => ({
          session: s,
          repo: clinic,
          scheduling: new RisRepository(db),
          screening: new PostgresScreeningRepository(db),
          messaging: new PostgresMessagingRepository(db),
          sms: this.sms,
          jobs: new PostgresJobQueue(db),
          audit: new PostgresAuditWriter(db),
          transferAvailable: false,
          logger: this.deps.logger,
          timeZone: this.deps.timeZone,
          now: () => new Date(),
          requestId: randomUUID(),
        }),
        recordTurn: (s, turn: TurnRecord) => {
          if (turn.role === "tool") {
            this.tools.push({
              name: turn.toolName ?? "?",
              ok: Boolean((turn.toolResult as { ok?: boolean } | undefined)?.ok),
              // State is recorded after the tool ran; verify_identity itself counts as pre-verification.
              verifiedAtCall:
                turn.toolName === "verify_identity" ? false : Boolean(s.verifiedPatientId),
            });
          }
          this.calls.recordTurn(s.callId, ++s.turnSeq, turn);
        },
      },
      session,
      text,
      (sentence) => spoken.push(sentence),
    );
    const reply = spoken.join(" ");
    this.transcript.push({
      role: "agent",
      text: reply,
      verified: Boolean(session.verifiedPatientId),
    });
    return reply;
  }

  async finish(): Promise<RunObservation> {
    await this.calls.endCall(this.session.callId, {
      medianLatencyMs: null,
      flagged: false,
      endReason: "hangup",
    });
    return { ...this.snapshot(), db: await this.observeDb() };
  }

  private snapshot() {
    return {
      tools: this.tools,
      transcript: this.transcript,
      verified: Boolean(this.session.verifiedPatientId),
      lockedOut: this.session.lockedOut,
      language: this.session.language,
    };
  }

  private async observeDb(): Promise<RunObservation["db"]> {
    const { db } = this.deps;
    const callId = this.session.callId;
    const patientId = this.session.verifiedPatientId;
    const count = (n: { count: string | number | bigint } | undefined) => Number(n?.count ?? 0);

    const voiceBookings = patientId
      ? await db
          .selectFrom("appointments")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("patient_id", "=", patientId)
          .where("created_via", "=", "voice")
          .executeTakeFirst()
      : undefined;
    const cancelled = patientId
      ? await db
          .selectFrom("appointments")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("patient_id", "=", patientId)
          .where("status", "=", "cancelled")
          .executeTakeFirst()
      : undefined;
    const tasks = await db
      .selectFrom("tasks")
      .select(["type"])
      .where("call_id", "=", callId)
      .execute();
    const screening = patientId
      ? await db
          .selectFrom("screenings as s")
          .innerJoin("appointments as a", "a.id", "s.appointment_id")
          .select(["s.status", "s.answers"])
          .where("a.patient_id", "=", patientId)
          .orderBy("s.updated_at", "desc")
          .executeTakeFirst()
      : undefined;
    const answers = (screening?.answers ?? {}) as Record<string, { callerWords?: string | null }>;
    const templates = await db.selectFrom("prep_templates").select(["body", "language"]).execute();
    const smsLanguages = this.sms.sent.map(
      (m) => templates.find((t) => t.body === m.body)?.language ?? "unknown",
    );

    return {
      voiceBookings: count(voiceBookings),
      cancelledAppointments: count(cancelled),
      callbackTasks: tasks.filter((t) => t.type === "callback").length,
      reviewTasks: tasks.filter((t) => t.type === "review").length,
      screeningStatus: screening?.status ?? null,
      screeningWords: Object.values(answers)
        .map((a) => a.callerWords ?? "")
        .filter(Boolean),
      smsSent: this.sms.sent.length,
      smsLanguages,
    };
  }
}
