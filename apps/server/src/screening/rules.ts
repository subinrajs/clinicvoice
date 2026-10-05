import type { AGENT_SETTABLE_SCREENING_STATUSES, ScreeningAnswer } from "@clinicvoice/shared";
import { z } from "zod";
import rulesJson from "./screening-rules.v1.json" with { type: "json" };

const RuleSet = z.object({
  version: z.string(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        flag: z.boolean(),
        contrastOnly: z.boolean().optional(),
        en: z.string(),
        fr: z.string(),
      }),
    )
    .min(1),
});
export type RuleSet = z.infer<typeof RuleSet>;
export type ScreeningQuestion = RuleSet["questions"][number];

/** Validated at module load: a malformed rules file must stop the server, not degrade silently. */
export const SCREENING_RULES: RuleSet = RuleSet.parse(rulesJson);

export type AgentScreeningStatus = (typeof AGENT_SETTABLE_SCREENING_STATUSES)[number];

export function questionsFor(rules: RuleSet, contrast: boolean): ScreeningQuestion[] {
  return rules.questions.filter((q) => contrast || !q.contrastOnly);
}

export function nextQuestion(
  rules: RuleSet,
  contrast: boolean,
  answers: Record<string, ScreeningAnswer>,
): ScreeningQuestion | null {
  return questionsFor(rules, contrast).find((q) => !(q.id in answers)) ?? null;
}

/**
 * Deterministic status from answers. Returns only statuses the agent may set: any yes/unsure on a
 * flagged question is needs_review; otherwise in_progress. Completing every question still yields
 * in_progress, because only a technologist can mark a screening clear.
 */
export function evaluateScreening(
  rules: RuleSet,
  answers: Record<string, ScreeningAnswer>,
): AgentScreeningStatus {
  const flagged = new Set(rules.questions.filter((q) => q.flag).map((q) => q.id));
  const needsReview = Object.entries(answers).some(
    ([id, answer]) => flagged.has(id) && (answer === "yes" || answer === "unsure"),
  );
  return needsReview ? "needs_review" : "in_progress";
}
