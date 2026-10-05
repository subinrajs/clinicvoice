import Anthropic from "@anthropic-ai/sdk";
import { createDb, type Db } from "@clinicvoice/db";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { loadVoiceAgentPrompt } from "./agent/systemPrompt.js";
import type { Env } from "./config/env.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { PostgresAuditWriter } from "./repositories/auditRepository.js";
import { PostgresCallRepository } from "./repositories/callRepository.js";
import { PostgresClinicRepository } from "./repositories/clinicRepository.js";
import { RisRepository } from "./repositories/risRepository.js";
import { healthRoutes } from "./routes/health.js";
import { risRoutes } from "./routes/ris.js";
import { twilioSignatureGuard } from "./routes/twilioSignature.js";
import { voiceRoutes } from "./routes/voice.js";
import { createToolRegistry } from "./tools/registry.js";

export interface AppOverrides {
  db?: Db;
  anthropic?: Pick<Anthropic, "messages">;
  logger?: Logger;
}

/** Composition root: wires configuration, infrastructure and routes. No side effects beyond I/O setup. */
export async function buildApp(env: Env, overrides: AppOverrides = {}) {
  const logger = overrides.logger ?? createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
  const db = overrides.db ?? createDb({ connectionString: env.DATABASE_URL });
  const anthropic =
    overrides.anthropic ??
    new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 10_000 });

  const clinicRepo = new PostgresClinicRepository(db);
  const audit = new PostgresAuditWriter(db);
  const calls = new PostgresCallRepository(db, logger);
  const ris = new RisRepository(db);
  const tools = createToolRegistry();
  const systemPrompt = await loadVoiceAgentPrompt(clinicRepo, env.PROMPTS_DIR);
  const activeCalls = new Set<string>();

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(rateLimit, { global: false });

  const verifyTwilio = twilioSignatureGuard({
    authToken: env.TWILIO_AUTH_TOKEN,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    enforce: env.NODE_ENV === "production",
  });

  await app.register(healthRoutes(db));
  await app.register(
    voiceRoutes({
      publicBaseUrl: env.PUBLIC_BASE_URL,
      verifyTwilio,
      relay: {
        calls,
        logger,
        phoneHashKey: env.PHONE_HASH_KEY,
        maxConcurrentCalls: env.MAX_CONCURRENT_CALLS,
        activeCalls,
        agent: {
          client: anthropic,
          model: env.ANTHROPIC_LIVE_MODEL,
          systemPrompt,
          tools,
          logger,
          toolContext: (session) => ({
            session,
            repo: clinicRepo,
            audit,
            logger: logger.child({ callId: session.callId }),
            timeZone: env.CLINIC_TIMEZONE,
            now: () => new Date(),
            requestId: randomUUID(),
          }),
        },
      },
    }),
  );
  await app.register(risRoutes(ris, env.RIS_API_KEY), { prefix: "/ris/v1" });

  const holdSweep = setInterval(() => {
    ris.releaseExpiredHolds().catch((err: unknown) => logger.error({ err }, "hold sweep failed"));
  }, 60_000);
  holdSweep.unref();

  app.addHook("onClose", async () => {
    clearInterval(holdSweep);
    await calls.drain();
    if (!overrides.db) await db.destroy();
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
