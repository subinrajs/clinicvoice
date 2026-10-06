/**
 * Scripted conversation suite (text mode, real model, real database).
 *
 *   pnpm --filter @clinicvoice/server conversations [--runs 3] [--grade] [--only 05]
 *
 * Reseeds the database before every run, so point it at a disposable database. Each script must
 * pass every run. Writes tests/conversations/report.md and report.json.
 */
import { createDb } from "@clinicvoice/db";
import { seed } from "@clinicvoice/db/seed";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadPrompt } from "../src/agent/prompts.js";
import { loadVoiceAgentPrompt, VOICE_AGENT_PROMPT_VERSION } from "../src/agent/systemPrompt.js";
import { evaluate, type RunObservation } from "../src/harness/assertions.js";
import { ConversationScript } from "../src/harness/script.js";
import { TextCall } from "../src/harness/textCall.js";
import { createLogger } from "../src/lib/logger.js";
import { OpenAIChatModel } from "../src/llm/openaiChatModel.js";
import { OpenAIStructuredModel } from "../src/llm/structuredModel.js";
import { PostgresClinicRepository } from "../src/repositories/clinicRepository.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPTS_DIR = path.join(ROOT, "tests/conversations");

const GradeSchema = z.strictObject({
  brief_and_spoken: z.boolean(),
  no_clinical_advice: z.boolean(),
  correct_escalation: z.boolean(),
  pass: z.boolean(),
  reason: z.string().max(400),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "3" },
      grade: { type: "boolean", default: false },
      only: { type: "string" },
    },
  });
  if (process.env.NODE_ENV === "production")
    throw new Error("Refusing to run the suite against production (it reseeds the database)");
  const runs = Number(values.runs);
  const logger = createLogger(process.env.LOG_LEVEL ?? "warn");
  const timeZone = process.env.CLINIC_TIMEZONE ?? "America/Toronto";
  const owner = createDb({
    connectionString: requireEnv("DATABASE_MIGRATION_URL"),
    maxConnections: 2,
  });
  const db = createDb({ connectionString: requireEnv("DATABASE_URL"), maxConnections: 5 });
  const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  const model = new OpenAIChatModel({
    client: openai,
    model: process.env.OPENAI_LIVE_MODEL ?? "gpt-5.4-mini",
    ...(process.env.OPENAI_LIVE_REASONING_EFFORT
      ? { reasoningEffort: process.env.OPENAI_LIVE_REASONING_EFFORT as "none" }
      : {}),
  });
  const grader = new OpenAIStructuredModel(openai, process.env.OPENAI_OFFLINE_MODEL ?? "gpt-5.5");
  const rubric = values.grade ? await loadPrompt("transcript-grader.v1") : "";

  const files = (await readdir(SCRIPTS_DIR)).filter((f) => f.endsWith(".yaml")).sort();
  const scripts = await Promise.all(
    files.map(async (f) =>
      ConversationScript.parse(parseYaml(await readFile(path.join(SCRIPTS_DIR, f), "utf8"))),
    ),
  );
  const selected = values.only ? scripts.filter((s) => s.id.startsWith(values.only!)) : scripts;

  const results: {
    id: string;
    description: string;
    runs: {
      failures: string[];
      transcript: RunObservation["transcript"];
      grade?: z.infer<typeof GradeSchema>;
    }[];
  }[] = [];

  for (const script of selected) {
    const entry = {
      id: script.id,
      description: script.description,
      runs: [] as (typeof results)[number]["runs"],
    };
    for (let run = 1; run <= runs; run++) {
      await seed(owner);
      const systemPrompt = await loadVoiceAgentPrompt(new PostgresClinicRepository(db));
      const call = new TextCall({ db, model, systemPrompt, logger, timeZone });
      await call.start();
      let failures: string[];
      let observation: RunObservation | undefined;
      try {
        for (const line of script.caller) await call.say(line);
        observation = await call.finish();
        failures = evaluate(script, observation);
      } catch (err) {
        failures = [`run crashed: ${err instanceof Error ? err.message : String(err)}`];
      }
      let grade: z.infer<typeof GradeSchema> | undefined;
      if (values.grade && observation) {
        const transcript = observation.transcript
          .map((l) => `${l.role === "caller" ? "Caller" : "Assistant"}: ${l.text}`)
          .join("\n");
        grade = (
          await grader.generate({
            name: "transcript_grade",
            system: rubric,
            input: `Scenario: ${script.description}\n\n${transcript}`,
            schema: GradeSchema,
          })
        ).value;
        if (!grade.pass) failures.push(`grader: ${grade.reason}`);
      }
      entry.runs.push({
        failures,
        transcript: observation?.transcript ?? [],
        ...(grade ? { grade } : {}),
      });
      process.stdout.write(
        `${failures.length ? "✗" : "✓"} ${script.id} run ${run}/${runs}${failures.length ? `: ${failures.join("; ")}` : ""}\n`,
      );
    }
    results.push(entry);
  }

  const passed = results.filter((r) => r.runs.every((run) => run.failures.length === 0));
  const report = [
    `# Scripted conversation report`,
    ``,
    `- Date: ${new Date().toISOString()}`,
    `- Prompt: ${VOICE_AGENT_PROMPT_VERSION}, model: ${model.model}, runs per script: ${runs}${values.grade ? ", graded" : ""}`,
    `- **Passed ${passed.length} of ${results.length}** (a script passes only if every run passes)`,
    ``,
    `| Script | Result | Failures |`,
    `|---|---|---|`,
    ...results.map((r) => {
      const failed = r.runs.filter((run) => run.failures.length);
      return `| ${r.id}: ${r.description} | ${failed.length ? `✗ ${runs - failed.length}/${runs}` : `✓ ${runs}/${runs}`} | ${
        failed
          .flatMap((f) => f.failures)
          .slice(0, 3)
          .join("<br>") || ""
      } |`;
    }),
  ].join("\n");
  await writeFile(path.join(SCRIPTS_DIR, "report.md"), `${report}\n`);
  await writeFile(path.join(SCRIPTS_DIR, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`\n${report}\n`);

  await db.destroy();
  await owner.destroy();
  process.exitCode = passed.length === results.length ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
