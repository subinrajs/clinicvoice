import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PUBLIC_BASE_URL: z.url(),
  CLINIC_TIMEZONE: z.string().default("America/Toronto"),
  /** Directory holding prompts/*.md. Defaults to the repo's prompts/ folder. */
  PROMPTS_DIR: z.string().optional(),

  DATABASE_URL: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_LIVE_MODEL: z.string().default("claude-haiku-4-5"),
  ANTHROPIC_OFFLINE_MODEL: z.string().default("claude-sonnet-5"),

  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().default(""),
  STAFF_TRANSFER_NUMBER: z.string().default(""),

  PHONE_HASH_KEY: z.string().min(32, "PHONE_HASH_KEY must be at least 32 characters"),
  RIS_API_KEY: z.string().min(16, "RIS_API_KEY must be at least 16 characters"),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(5),
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
  return result.data;
}
