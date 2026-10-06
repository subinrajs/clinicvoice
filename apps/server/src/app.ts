import { createDb, type Db } from "@clinicvoice/db";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { loadPrompt } from "./agent/prompts.js";
import { loadVoiceAgentPrompt } from "./agent/systemPrompt.js";
import type { Env } from "./config/env.js";
import { DashboardRepository } from "./dashboard/dashboardRepository.js";
import { DashboardEvents } from "./dashboard/events.js";
import { dashboardRoutes } from "./dashboard/routes.js";
import { CALL_SUMMARY_PROMPT, createJobHandlers, IMPLANT_EXTRACT_PROMPT } from "./jobs/handlers.js";
import { JobWorker, PostgresJobQueue } from "./jobs/jobQueue.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { OpenAIChatModel } from "./llm/openaiChatModel.js";
import { OpenAIStructuredModel, type StructuredModel } from "./llm/structuredModel.js";
import type { ChatModel } from "./llm/types.js";
import { PostgresMessagingRepository } from "./messaging/messagingRepository.js";
import { RecordingSmsSender, TwilioSmsSender, type SmsSender } from "./messaging/smsSender.js";
import { PostgresAuditWriter } from "./repositories/auditRepository.js";
import { PostgresCallRepository } from "./repositories/callRepository.js";
import { PostgresClinicRepository } from "./repositories/clinicRepository.js";
import { RisRepository } from "./repositories/risRepository.js";
import { PostgresScreeningRepository } from "./repositories/screeningRepository.js";
import { PostgresUsageRepository } from "./repositories/usageRepository.js";
import { healthRoutes } from "./routes/health.js";
import { risRoutes } from "./routes/ris.js";
import { twilioSignatureGuard } from "./routes/twilioSignature.js";
import { voiceRoutes } from "./routes/voice.js";
import { createToolRegistry } from "./tools/registry.js";

export interface AppOverrides {
  db?: Db;
  model?: ChatModel;
  structuredModel?: StructuredModel;
  sms?: SmsSender;
  logger?: Logger;
  /** Tests disable background loops (worker, LISTEN) to keep runs deterministic. */
  background?: boolean;
}

/** Composition root: wires configuration, infrastructure and routes. */
export async function buildApp(env: Env, overrides: AppOverrides = {}) {
  const logger = overrides.logger ?? createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
  const db = overrides.db ?? createDb({ connectionString: env.DATABASE_URL });
  const background = overrides.background ?? true;

  // One quick retry at most: a caller is waiting, so a slow failure is worse than a fast one.
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 1, timeout: 10_000 });
  const model =
    overrides.model ??
    new OpenAIChatModel({
      client: openai,
      model: env.OPENAI_LIVE_MODEL,
      ...(env.OPENAI_LIVE_REASONING_EFFORT
        ? { reasoningEffort: env.OPENAI_LIVE_REASONING_EFFORT }
        : {}),
    });
  const structuredModel =
    overrides.structuredModel ??
    new OpenAIStructuredModel(
      new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 2, timeout: 60_000 }),
      env.OPENAI_OFFLINE_MODEL,
    );
  const sms =
    overrides.sms ??
    (env.SMS_MODE === "twilio"
      ? new TwilioSmsSender(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_PHONE_NUMBER)
      : new RecordingSmsSender(logger));

  const clinicRepo = new PostgresClinicRepository(db);
  const audit = new PostgresAuditWriter(db);
  const calls = new PostgresCallRepository(db, logger);
  const ris = new RisRepository(db);
  const screening = new PostgresScreeningRepository(db);
  const messaging = new PostgresMessagingRepository(db);
  const usage = new PostgresUsageRepository(db);
  const jobs = new PostgresJobQueue(db);
  const dashboard = new DashboardRepository(db);
  const events = new DashboardEvents(env.DATABASE_URL, logger);
  const tools = createToolRegistry();
  const systemPrompt = await loadVoiceAgentPrompt(clinicRepo, env.PROMPTS_DIR);
  const worker = new JobWorker(
    db,
    createJobHandlers({
      db,
      model: structuredModel,
      usage,
      logger,
      prompts: {
        callSummary: await loadPrompt(CALL_SUMMARY_PROMPT, env.PROMPTS_DIR),
        implantExtract: await loadPrompt(IMPLANT_EXTRACT_PROMPT, env.PROMPTS_DIR),
      },
    }),
    logger,
  );

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
      staffTransferNumber: env.STAFF_TRANSFER_NUMBER,
      clinic: clinicRepo,
      relay: {
        calls,
        clinic: clinicRepo,
        usage,
        jobs,
        logger,
        phoneHashKey: env.PHONE_HASH_KEY,
        activeCalls: new Set<string>(),
        admission: {
          maxConcurrentCalls: env.MAX_CONCURRENT_CALLS,
          maxCallsPerNumberPerHour: env.MAX_CALLS_PER_NUMBER_PER_HOUR,
          dailyTokenBudget: env.DAILY_TOKEN_BUDGET,
          timeZone: env.CLINIC_TIMEZONE,
        },
        agent: {
          model,
          systemPrompt,
          tools,
          logger,
          toolContext: (session) => ({
            session,
            repo: clinicRepo,
            scheduling: ris,
            screening,
            messaging,
            sms,
            jobs,
            audit,
            transferAvailable: Boolean(env.STAFF_TRANSFER_NUMBER),
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
  await app.register(
    dashboardRoutes({
      repo: dashboard,
      audit,
      events,
      sessionSecret: env.SESSION_SECRET,
      secureCookies: env.NODE_ENV === "production",
      timeZone: env.CLINIC_TIMEZONE,
    }),
    { prefix: "/api" },
  );

  const holdSweep = setInterval(() => {
    ris.releaseExpiredHolds().catch((err: unknown) => logger.error({ err }, "hold sweep failed"));
  }, 60_000);
  holdSweep.unref();

  if (background) {
    await events.start();
    if (env.RUN_WORKER) worker.start();
  }

  app.addHook("onClose", async () => {
    clearInterval(holdSweep);
    await worker.stop();
    await events.stop();
    await calls.drain();
    if (!overrides.db) await db.destroy();
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
