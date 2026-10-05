import { describe, expect, it } from "vitest";
import {
  evaluateScreening,
  nextQuestion,
  questionsFor,
  SCREENING_RULES,
} from "../src/screening/rules.js";

describe("screening rules v1", () => {
  it("loads and validates the versioned rule file", () => {
    expect(SCREENING_RULES.version).toBe("screening-rules.v1");
  });

  it.each(["yes", "unsure"] as const)("flags %s on a risk question for review", (answer) => {
    expect(evaluateScreening(SCREENING_RULES, { pacemaker: answer })).toBe("needs_review");
  });

  it("never returns clear, even when every answer is no", () => {
    const allNo = Object.fromEntries(SCREENING_RULES.questions.map((q) => [q.id, "no" as const]));
    expect(evaluateScreening(SCREENING_RULES, allNo)).toBe("in_progress");
  });

  it("ignores non-flagged questions", () => {
    expect(evaluateScreening(SCREENING_RULES, { claustrophobia: "yes" })).toBe("in_progress");
  });

  it("asks contrast questions only for contrast exams", () => {
    const ids = (contrast: boolean) => questionsFor(SCREENING_RULES, contrast).map((q) => q.id);
    expect(ids(false)).not.toContain("kidney");
    expect(ids(true)).toContain("kidney");
  });

  it("walks the questions in order", () => {
    expect(nextQuestion(SCREENING_RULES, false, {})?.id).toBe("pacemaker");
    expect(nextQuestion(SCREENING_RULES, false, { pacemaker: "no" })?.id).toBe("neurostimulator");
  });
});
