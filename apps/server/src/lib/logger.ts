import pino, { type Logger } from "pino";

/**
 * Keys that may carry PHI or secrets. pino replaces their values before serialization, so the
 * transcripts and identity fields stored in Postgres never reach log output or a log vendor.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-ris-api-key']",
  "req.headers['x-twilio-signature']",
  "*.dob",
  "*.first_name",
  "*.last_name",
  "*.firstName",
  "*.lastName",
  "*.phone",
  "*.phone_e164",
  "*.phone_last4",
  "*.from",
  "*.voicePrompt",
  "*.text",
  "*.transcript",
  "*.health_card_token",
  "*.free_text",
];

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "clinicvoice-server" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: "pino-pretty" } } : {}),
  });
}

export type { Logger };
