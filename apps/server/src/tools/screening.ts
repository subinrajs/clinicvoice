import { ScreeningAnswer, ToolErrorCode } from "@clinicvoice/shared";
import { z } from "zod";
import type { RecordedAnswer } from "../repositories/screeningRepository.js";
import { evaluateScreening, nextQuestion, SCREENING_RULES } from "../screening/rules.js";
import { defineTool } from "./defineTool.js";
import { requireVerified } from "./guards.js";
import { agentActor, resolveAppointment } from "./shared.js";
import { fail, ok, type ToolResult } from "./types.js";

/** Questions whose "yes"/"unsure" answers describe a device worth structuring for the technologist. */
const IMPLANT_QUESTIONS = new Set([
  "pacemaker",
  "neurostimulator",
  "aneurysm_clip",
  "metal_fragments",
  "implants_other",
]);

export const recordScreeningAnswer = defineTool({
  name: "record_screening_answer",
  description:
    "MRI safety pre-screening. Call with only appointment_ref to get the first question. Then, after each caller answer, call with question_id, answer (yes/no/unsure) and the caller's exact words. Ask the returned next question word for word. Never say whether the scan is safe.",
  input: z.object({
    appointment_ref: z.string(),
    question_id: z.string().optional(),
    answer: ScreeningAnswer.optional(),
    caller_words: z
      .string()
      .max(500)
      .optional()
      .describe("The caller's answer verbatim, especially any device or surgery details"),
  }),
  guards: [requireVerified],
  async run(input, ctx): Promise<ToolResult> {
    if ((input.question_id === undefined) !== (input.answer === undefined)) {
      return fail(ToolErrorCode.INVALID_INPUT, "question_id and answer must be given together.");
    }
    const resolved = await resolveAppointment(ctx, input.appointment_ref);
    if (!resolved.ok) return resolved.result;
    const { appointment } = resolved;
    if (appointment.modality !== "MRI") {
      return fail(
        ToolErrorCode.UNKNOWN_QUESTION,
        "Safety screening is only needed for MRI appointments.",
      );
    }

    const screening = await ctx.screening.getOrCreate(appointment.id, SCREENING_RULES.version);
    if (screening.status !== "in_progress" && screening.status !== "needs_review") {
      return ok({
        done: true,
        message: "This screening has already been reviewed by a technologist.",
      });
    }

    const answers: Record<string, RecordedAnswer> = { ...screening.answers };
    let status = screening.status;

    if (input.question_id && input.answer) {
      const question = SCREENING_RULES.questions.find((q) => q.id === input.question_id);
      if (!question)
        return fail(
          ToolErrorCode.UNKNOWN_QUESTION,
          "Unknown question id. Use the id returned by this tool.",
        );
      answers[question.id] = {
        answer: input.answer,
        callerWords: input.caller_words ?? null,
        at: ctx.now().toISOString(),
      };

      const simple = Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.answer]));
      // Rules only escalate: once needs_review, the agent never moves a screening back.
      status =
        status === "needs_review" ? "needs_review" : evaluateScreening(SCREENING_RULES, simple);
      await ctx.screening.saveAnswers(screening.id, answers, status);
      await ctx.audit.write({
        actor: agentActor(ctx),
        action: "update",
        entity: "screening",
        entityId: screening.id,
        requestId: ctx.requestId,
      });

      if (input.answer !== "no" && IMPLANT_QUESTIONS.has(question.id) && input.caller_words) {
        await ctx.jobs.enqueue(
          "implant_extraction",
          { screeningId: screening.id, questionId: question.id },
          { dedupeKey: `implant:${screening.id}:${question.id}:${answers[question.id]!.at}` },
        );
      }
      if (status === "needs_review" && screening.status !== "needs_review") {
        await ctx.repo.createTask({
          type: "review",
          callId: ctx.session.callId,
          patientId: ctx.session.verifiedPatientId,
          reason: `MRI screening flagged on "${question.id}". Technologist review required before the scan.`,
          assignedRole: "technologist",
          screeningId: screening.id,
        });
      }
    }

    const simpleAnswers = Object.fromEntries(
      Object.entries(answers).map(([id, a]) => [id, a.answer]),
    );
    const next = nextQuestion(SCREENING_RULES, appointment.contrast, simpleAnswers);
    if (next) {
      return ok({
        next_question: { id: next.id, ask: ctx.session.language === "fr" ? next.fr : next.en },
      });
    }
    return ok({
      done: true,
      flagged_for_review: status === "needs_review",
      message:
        status === "needs_review"
          ? "Tell the caller a technologist will review their answers before the visit and may call them. Do not say whether the scan can go ahead."
          : "Tell the caller their answers are recorded and a technologist will confirm everything at check-in.",
    });
  },
});
