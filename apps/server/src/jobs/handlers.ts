import type { Db } from "@clinicvoice/db";
import { sql } from "kysely";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { StructuredModel } from "../llm/structuredModel.js";
import type { ImplantEntry, RecordedAnswer } from "../repositories/screeningRepository.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import type { JobHandlers } from "./jobQueue.js";

export const CALL_SUMMARY_PROMPT = "call-summary.v1";
export const IMPLANT_EXTRACT_PROMPT = "implant-extract.v1";

export const CallSummarySchema = z.strictObject({
  intent: z.enum([
    "book",
    "reschedule",
    "cancel",
    "screening",
    "prep_instructions",
    "general_question",
    "medical_question",
    "other",
  ]),
  outcome: z.enum([
    "resolved",
    "callback_needed",
    "transferred",
    "identity_failed",
    "abandoned",
    "unresolved",
  ]),
  actions: z.array(z.string().max(200)).max(10),
  follow_up_needed: z.boolean(),
  follow_up_reason: z.string().max(300).nullable(),
  flag_for_review: z.boolean(),
  flag_reason: z.string().max(300).nullable(),
  summary: z.string().max(600),
});
export type CallSummary = z.infer<typeof CallSummarySchema>;

export const ImplantExtractionSchema = z.strictObject({
  implants: z
    .array(
      z.strictObject({
        device: z.string().max(120),
        body_location: z.string().max(80).nullable(),
        caller_words: z.string().max(500),
        needs_follow_up: z.boolean(),
      }),
    )
    .max(10),
});

export interface JobDeps {
  db: Db;
  model: StructuredModel;
  usage: UsageRepository;
  logger: Logger;
  prompts: { callSummary: string; implantExtract: string };
}

/** Renders a call for the summarizer: spoken lines verbatim, tool calls as name + outcome only. */
export function renderTranscript(
  turns: { role: string; text: string | null; tool_name: string | null; tool_result: unknown }[],
): string {
  return turns
    .map((turn) => {
      if (turn.role === "tool") {
        const result = turn.tool_result as { ok?: boolean; error?: { code?: string } } | null;
        return `[tool ${turn.tool_name}: ${result?.ok ? "ok" : `error ${result?.error?.code ?? "unknown"}`}]`;
      }
      if (turn.role === "system") return `[system: ${turn.text}]`;
      return `${turn.role === "caller" ? "Caller" : "Assistant"}: ${turn.text ?? ""}`;
    })
    .join("\n");
}

/**
 * Keeps the caller's words verbatim even if the model "tidies" them: any quote that is not an
 * exact substring of what the caller said is replaced with the full original answer.
 */
export function enforceVerbatim(
  implants: z.infer<typeof ImplantExtractionSchema>["implants"],
  original: string,
): ImplantEntry[] {
  return implants.map((i) => ({
    device: i.device,
    bodyLocation: i.body_location,
    callerWords:
      original.includes(i.caller_words) && i.caller_words.trim() ? i.caller_words : original,
    needsFollowUp: i.needs_follow_up,
  }));
}

export function createJobHandlers(deps: JobDeps): JobHandlers {
  const { db, model, usage } = deps;

  return {
    async call_summary({ callId }) {
      const turns = await db
        .selectFrom("call_turns")
        .select(["role", "text", "tool_name", "tool_result"])
        .where("call_id", "=", callId)
        .orderBy("seq")
        .execute();
      if (turns.length === 0) {
        await db
          .updateTable("calls")
          .set({ outcome: "abandoned" })
          .where("id", "=", callId)
          .execute();
        return;
      }
      const { value, usage: tokens } = await model.generate({
        name: "call_summary",
        system: deps.prompts.callSummary,
        input: renderTranscript(turns),
        schema: CallSummarySchema,
      });
      await usage.record({ callId, purpose: "call_summary", model: model.model, ...tokens });

      const filterHit = turns.some((t) => t.role === "system" && t.text === "output_filter_hit");
      await db
        .updateTable("calls")
        .set({
          summary: JSON.stringify({ ...value, prompt_version: CALL_SUMMARY_PROMPT }),
          outcome: value.outcome,
          flagged: sql<boolean>`flagged OR ${value.flag_for_review || filterHit || value.outcome === "identity_failed"}`,
        })
        .where("id", "=", callId)
        .execute();

      if (value.follow_up_needed) {
        const call = await db
          .selectFrom("calls")
          .select("verified_patient_id")
          .where("id", "=", callId)
          .executeTakeFirstOrThrow();
        const existing = await db
          .selectFrom("tasks")
          .select("id")
          .where("call_id", "=", callId)
          .where("type", "=", "callback")
          .executeTakeFirst();
        if (!existing) {
          await db
            .insertInto("tasks")
            .values({
              type: "callback",
              call_id: callId,
              patient_id: call.verified_patient_id,
              reason: value.follow_up_reason ?? "Follow-up identified by post-call summary",
              assigned_role: "front_desk",
            })
            .execute();
        }
      }
    },

    async implant_extraction({ screeningId, questionId }) {
      const screening = await db
        .selectFrom("screenings")
        .select(["answers", "implants"])
        .where("id", "=", screeningId)
        .executeTakeFirstOrThrow();
      const answer = (screening.answers as unknown as Record<string, RecordedAnswer>)[questionId];
      const words = answer?.callerWords?.trim();
      if (!words) return;

      const { value, usage: tokens } = await model.generate({
        name: "implant_extraction",
        system: deps.prompts.implantExtract,
        input: `Screening question id: ${questionId}\nCaller's answer: ${words}`,
        schema: ImplantExtractionSchema,
      });
      await usage.record({
        callId: null,
        purpose: "implant_extraction",
        model: model.model,
        ...tokens,
      });

      const extracted = enforceVerbatim(value.implants, words).map((i) => ({ ...i, questionId }));
      const others = (
        (screening.implants as unknown as (ImplantEntry & { questionId?: string })[]) ?? []
      ).filter((i) => i.questionId !== questionId);
      await db
        .updateTable("screenings")
        .set({ implants: JSON.stringify([...others, ...extracted]), updated_at: new Date() })
        .where("id", "=", screeningId)
        .execute();
    },
  };
}
