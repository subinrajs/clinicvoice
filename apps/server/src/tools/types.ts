import type { ToolErrorCode } from "@clinicvoice/shared";
import type { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { JobQueue } from "../jobs/jobQueue.js";
import type { MessagingPort } from "../messaging/messagingRepository.js";
import type { SmsSender } from "../messaging/smsSender.js";
import type { ClinicRepository } from "../repositories/clinicRepository.js";
import type { SchedulingPort } from "../repositories/risRepository.js";
import type { ScreeningPort } from "../repositories/screeningRepository.js";
import type { AuditWriter } from "../repositories/auditRepository.js";
import type { CallSession } from "../session/callSession.js";

export interface ToolError {
  code: ToolErrorCode;
  /** Guidance for the model, not for the caller's ears. Never contains PHI. */
  message: string;
}

export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: ToolError };

export interface ToolContext {
  session: CallSession;
  repo: ClinicRepository;
  scheduling: SchedulingPort;
  screening: ScreeningPort;
  messaging: MessagingPort;
  sms: SmsSender;
  jobs: JobQueue;
  audit: AuditWriter;
  /** True when a staff line is configured for warm transfer; otherwise transfers become callbacks. */
  transferAvailable: boolean;
  logger: Logger;
  timeZone: string;
  now: () => Date;
  requestId: string;
  /** The registry, for tools that act on other tools (propose_action). */
  tools: ReadonlyMap<string, ToolDefinition>;
}

/** A guard returns null to let the call proceed, or the error to hand back to the model. */
export type Guard<I = unknown> = (ctx: ToolContext, input: I, toolName: string) => ToolError | null;

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject, O = unknown> {
  name: string;
  description: string;
  input: S;
  guards: Guard<z.infer<S>>[];
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolResult<O>>;
  /**
   * Required for confirmed-write tools: the server-generated sentence read back to the caller
   * before the write. Generated from the arguments, never from model text, so what the caller
   * hears is exactly what will be executed.
   */
  describe?: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

export const ok = <T>(data: T): ToolResult<T> => ({ ok: true, data });
export const fail = (code: ToolErrorCode, message: string): ToolResult<never> => ({
  ok: false,
  error: { code, message },
});
