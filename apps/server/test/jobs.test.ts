import { describe, expect, it } from "vitest";
import { enforceVerbatim, renderTranscript } from "../src/jobs/handlers.js";

describe("renderTranscript", () => {
  it("keeps spoken lines and reduces tool calls to name and outcome", () => {
    const text = renderTranscript([
      { role: "caller", text: "Move my MRI", tool_name: null, tool_result: null },
      {
        role: "tool",
        text: null,
        tool_name: "verify_identity",
        tool_result: { ok: false, error: { code: "NO_MATCH" } },
      },
      {
        role: "tool",
        text: null,
        tool_name: "find_appointments",
        tool_result: { ok: true, data: { appointments: [{ ref: "APPT1" }] } },
      },
      { role: "system", text: "output_filter_hit", tool_name: null, tool_result: null },
      { role: "agent", text: "Done.", tool_name: null, tool_result: null },
    ]);
    expect(text).toBe(
      "Caller: Move my MRI\n[tool verify_identity: error NO_MATCH]\n[tool find_appointments: ok]\n[system: output_filter_hit]\nAssistant: Done.",
    );
  });
});

describe("enforceVerbatim", () => {
  const original = "I'm not sure, I had knee surgery in 2019 and they put in a plate";
  it("keeps exact quotes", () => {
    const [entry] = enforceVerbatim(
      [
        {
          device: "orthopedic plate",
          body_location: "knee",
          caller_words: "they put in a plate",
          needs_follow_up: true,
        },
      ],
      original,
    );
    expect(entry).toEqual({
      device: "orthopedic plate",
      bodyLocation: "knee",
      callerWords: "they put in a plate",
      needsFollowUp: true,
    });
  });

  it("replaces paraphrased quotes with the caller's full answer", () => {
    const [entry] = enforceVerbatim(
      [
        {
          device: "plate",
          body_location: "knee",
          caller_words: "They inserted a metal plate",
          needs_follow_up: true,
        },
      ],
      original,
    );
    expect(entry!.callerWords).toBe(original);
  });
});
