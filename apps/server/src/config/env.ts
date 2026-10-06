import { z } from "zod";

const flag = z.enum(["true", "false"]).transform((v) => v === "true");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PUBLIC_BASE_URL: z.url(),
  CLINIC_TIMEZONE: z.string().default("America/Toronto"),
  /** Directory holding prompts/*.md. Defaults to the repo's prompts/ folder. */
  PROMPTS_DIR: z.string().optional(),

  DATABASE_URL: z.string().min(1),

  OPENAI_API_KEY: z.string().min(1),
  /** Live phone turns: a small, fast model. */
  OPENAI_LIVE_MODEL: z.string().default("gpt-5.4-mini"),
  /** Reasoning tokens are silence on a phone call; keep this at "none" or "minimal" for live turns. */
  OPENAI_LIVE_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
  /** Post-call summaries, implant extraction and transcript grading, where nobody is waiting. */
  OPENAI_OFFLINE_MODEL: z.string().default("gpt-5.5"),

  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().default(""),
  /** Staff line for warm transfers. Empty means transfers become callback tasks. */
  STAFF_TRANSFER_NUMBER: z.string().default(""),
  /** "twilio" sends real SMS; "record" keeps them in memory (local development, tests). */
  SMS_MODE: z.enum(["twilio", "record"]).default("record"),

  PHONE_HASH_KEY: z.string().min(32, "PHONE_HASH_KEY must be at least 32 characters"),
  RIS_API_KEY: z.string().min(16, "RIS_API_KEY must be at least 16 characters"),
  /** Signs staff dashboard session tokens. */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),

  MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(5),
  MAX_CALLS_PER_NUMBER_PER_HOUR: z.coerce.number().int().positive().default(6),
  /** Daily model-token ceiling across all calls and jobs; new calls are declined above it. */
  DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(2_000_000),
  /** Run the background job worker in this process. Disable when running a separate worker. */
  RUN_WORKER: flag.default(true),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parses and validates the environment once at startup; fails fast with every problem listed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const env = result.data;
  if (env.SMS_MODE === "twilio" && (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_PHONE_NUMBER)) {
    throw new Error("SMS_MODE=twilio requires TWILIO_ACCOUNT_SID and TWILIO_PHONE_NUMBER");
  }
  return env;
}
