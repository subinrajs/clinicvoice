import type Anthropic from "@anthropic-ai/sdk";
import pino from "pino";
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
  tasks: { type: string; reason: string; patientId: string | null }[] = [];
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
  async createTask(task: { type: string; reason: string; patientId: string | null }) {
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

export function makeContext(
  options: { session?: CallSession; tools?: ReadonlyMap<string, ToolDefinition> } = {},
) {
  const repo = new FakeClinicRepository();
  const audit = new FakeAuditWriter();
  const session =
    options.session ??
    createCallSession({ callId: "call-1", callSid: "CA123", fromHash: "hash-1" });
  const tools = options.tools ?? createToolRegistry();
  const ctx: ToolContext = {
    session,
    repo,
    audit,
    logger: silentLogger,
    timeZone: "America/Toronto",
    now: () => new Date("2026-10-05T14:00:00Z"),
    requestId: "req-1",
    tools,
  };
  return { ctx, repo, audit, session, tools };
}

export function verify(session: CallSession, patientId = MARIA.id) {
  session.verifiedPatientId = patientId;
  session.verifiedFirstName = "Maria";
}

/** A scripted model response: optional spoken text, optional tool calls. */
export interface ScriptedReply {
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
}

/**
 * Minimal stand-in for Anthropic's messages.stream(): replays scripted replies in order and
 * records each request so tests can assert on what the model was sent.
 */
export function fakeAnthropic(replies: ScriptedReply[]) {
  const requests: Anthropic.MessageStreamParams[] = [];
  let index = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageStreamParams) {
        requests.push(structuredClone(params));
        const reply = replies[index++];
        if (!reply) throw new Error(`No scripted reply for request #${index}`);
        const handlers: ((delta: string) => void)[] = [];
        return {
          on(event: string, handler: (delta: string) => void) {
            if (event === "text") handlers.push(handler);
            return this;
          },
          async finalMessage(): Promise<Anthropic.Message> {
            const content: Anthropic.ContentBlock[] = [];
            if (reply.text) {
              for (const chunk of reply.text.match(/.{1,7}/gs) ?? [])
                handlers.forEach((h) => h(chunk));
              content.push({ type: "text", text: reply.text, citations: null });
            }
            reply.tools?.forEach((t, i) =>
              content.push({
                type: "tool_use",
                id: `tu_${index}_${i}`,
                name: t.name,
                input: t.input,
              } as Anthropic.ToolUseBlock),
            );
            return {
              id: `msg_${index}`,
              type: "message",
              role: "assistant",
              model: "fake",
              content,
              stop_reason: reply.tools?.length ? "tool_use" : "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            } as unknown as Anthropic.Message;
          },
        };
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, "messages">, requests };
}
