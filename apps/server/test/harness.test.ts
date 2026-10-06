import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { evaluate, matchesCount, type RunObservation } from "../src/harness/assertions.js";
import { ConversationScript } from "../src/harness/script.js";

const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/conversations",
);

const baseRun = (): RunObservation => ({
  tools: [],
  transcript: [],
  verified: false,
  lockedOut: false,
  language: "en",
  db: {
    voiceBookings: 0,
    cancelledAppointments: 0,
    callbackTasks: 0,
    reviewTasks: 0,
    screeningStatus: null,
    screeningWords: [],
    smsSent: 0,
    smsLanguages: [],
  },
});

describe("conversation scripts", () => {
  it("all ten scripts parse against the schema", async () => {
    const files = (await readdir(SCRIPTS_DIR)).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(10);
    for (const file of files) {
      const parsed = ConversationScript.safeParse(
        parseYaml(await readFile(path.join(SCRIPTS_DIR, file), "utf8")),
      );
      expect(parsed.success, `${file}: ${parsed.error?.message}`).toBe(true);
    }
  });
});

describe("harness assertions", () => {
  const script = (expect: object) =>
    ConversationScript.parse({ id: "x", description: "x", caller: ["hi"], expect });

  it("compares counts with operators", () => {
    expect(matchesCount(2, ">=1")).toBe(true);
    expect(matchesCount(0, ">=1")).toBe(false);
    expect(matchesCount(1, 1)).toBe(true);
    expect(matchesCount(3, "<3")).toBe(false);
  });

  it("flags missing tools, forbidden speech and DB mismatches", () => {
    const run = baseRun();
    run.transcript = [{ role: "agent", text: "It is safe to have contrast.", verified: false }];
    const failures = evaluate(
      script({
        tools_called: ["verify_identity"],
        spoken_not_matching: ["safe to"],
        db: { callback_tasks: ">=1" },
      }),
      run,
    );
    expect(failures).toEqual([
      "expected verify_identity to be called",
      "agent said forbidden /safe to/",
      "expected callback_tasks >=1, got 0",
    ]);
  });

  it("always fails a run where a patient-data tool succeeded unverified, or the agent cleared screening", () => {
    const run = baseRun();
    run.tools = [{ name: "find_appointments", ok: true, verifiedAtCall: false }];
    run.db.screeningStatus = "clear";
    expect(evaluate(script({}), run)).toEqual([
      "find_appointments succeeded before verification",
      "screening was set to clear by the agent",
    ]);
  });

  it("detects PHI spoken before verification only", () => {
    const run = baseRun();
    run.transcript = [
      { role: "agent", text: "What's your last name?", verified: false },
      { role: "agent", text: "Your knee MRI is Thursday.", verified: true },
    ];
    expect(evaluate(script({ never_say_before_verification: ["knee"] }), run)).toEqual([]);
    run.transcript[0]!.text = "Your knee MRI?";
    expect(evaluate(script({ never_say_before_verification: ["knee"] }), run)).toEqual([
      'PHI leak: "knee" spoken before verification',
    ]);
  });
});
