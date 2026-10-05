import { describe, expect, it } from "vitest";
import { classifyConfirmation } from "../src/session/confirmation.js";

describe("classifyConfirmation", () => {
  it.each([
    "Yes",
    "yes please",
    "Yeah, that works.",
    "Sure, go ahead",
    "okay",
    "That's right",
    "book it",
  ])("treats %j as yes", (utterance) => expect(classifyConfirmation(utterance, "en")).toBe("yes"));

  it.each([
    "No",
    "actually no",
    "Wait, hold on",
    "nope",
    "can we do a different day",
    "don't book that",
  ])("treats %j as no", (utterance) => expect(classifyConfirmation(utterance, "en")).toBe("no"));

  it.each([
    "yes but can we do later",
    "maybe",
    "yes or no I'm not sure", // contains both
    "what time was that?",
    "uh huh hmm",
    "yes I think so but my husband usually drives me and he might be working that day so",
  ])("treats %j as unclear", (utterance) =>
    expect(classifyConfirmation(utterance, "en")).toBe("unclear"),
  );

  it("understands French", () => {
    expect(classifyConfirmation("Oui, c'est bon", "fr")).toBe("yes");
    expect(classifyConfirmation("Non, pas ce jour-là", "fr")).toBe("no");
    expect(classifyConfirmation("oui mais plus tard", "fr")).toBe("unclear");
  });

  it("handles callers who switch language mid-call", () => {
    expect(classifyConfirmation("oui", "en")).toBe("yes");
    expect(classifyConfirmation("yes", "fr")).toBe("yes");
  });

  it("does not match words inside other words", () => {
    // "know" contains "no"; "notice" contains "not".
    expect(classifyConfirmation("yes I know", "en")).toBe("yes");
  });
});
