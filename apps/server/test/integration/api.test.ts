/**
 * Dashboard API, job worker and usage accounting against a real Postgres. Requires the same env
 * as database.test.ts; reseeds the database.
 */
import { createDb, migrate, type Db } from "@clinicvoice/db";
import { seed } from "@clinicvoice/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { createJobHandlers } from "../../src/jobs/handlers.js";
import { JobWorker, PostgresJobQueue } from "../../src/jobs/jobQueue.js";
import type { StructuredModel } from "../../src/llm/structuredModel.js";
import { PostgresUsageRepository } from "../../src/repositories/usageRepository.js";
import { fakeChatModel, silentLogger } from "../helpers.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

const fakeStructured: StructuredModel = {
  model: "fake-offline",
  async generate({ name }) {
    const value =
      name === "call_summary"
        ? {
            intent: "general_question",
            outcome: "callback_needed",
            actions: ["Created callback task"],
            follow_up_needed: true,
            follow_up_reason: "Caller asked about contrast",
            flag_for_review: false,
            flag_reason: null,
            summary: "Caller asked about contrast safety; routed to staff.",
          }
        : { implants: [] };
    return { value, usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 80 } } as never;
  },
};

describe.skipIf(!appUrl || !ownerUrl)("API integration", () => {
  let db: Db;
  let owner: Db;
  let app: App;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    owner = createDb({ connectionString: ownerUrl!, maxConnections: 2 });
    await seed(owner);
    db = createDb({ connectionString: appUrl!, maxConnections: 5 });
    const env = loadEnv({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "https://example.test",
      DATABASE_URL: appUrl!,
      OPENAI_API_KEY: "test",
      TWILIO_AUTH_TOKEN: "test",
      PHONE_HASH_KEY: "k".repeat(32),
      RIS_API_KEY: "r".repeat(16),
      SESSION_SECRET: "s".repeat(32),
    });
    app = await buildApp(env, {
      db,
      model: fakeChatModel([]).model,
      structuredModel: fakeStructured,
      logger: silentLogger,
      background: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    await owner?.destroy();
  });

  async function login(email: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "lakeshore-demo" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "cv_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/api" });
    return `cv_session=${cookie.value}`;
  }

  it("rejects bad credentials with a generic error", async () => {
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "tech@lakeshore.example", password: "nope" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "who@lakeshore.example", password: "nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("requires a session for every dashboard endpoint", async () => {
    for (const url of [
      "/api/metrics",
      "/api/calls",
      "/api/screenings",
      "/api/tasks",
      "/api/schedule?date=2026-10-06",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("serves metrics, schedule and tasks to front desk", async () => {
    const cookie = await login("frontdesk@lakeshore.example");
    const metrics = await app.inject({ method: "GET", url: "/api/metrics", headers: { cookie } });
    expect(metrics.json()).toMatchObject({
      callsToday: expect.any(Number),
      openTasks: expect.any(Number),
    });

    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const schedule = await app.inject({
      method: "GET",
      url: `/api/schedule?date=${tomorrow}&site=MISS`,
      headers: { cookie },
    });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json().slots.every((s: { site_code: string }) => s.site_code === "MISS")).toBe(
      true,
    );
  });

  it("lets only technologists decide screenings, and requires the CSRF header", async () => {
    const appointment = await db
      .selectFrom("appointments")
      .select("id")
      .where("status", "=", "booked")
      .executeTakeFirstOrThrow();
    const screening = await db
      .insertInto("screenings")
      .values({
        appointment_id: appointment.id,
        rules_version: "screening-rules.v1",
        status: "needs_review",
        answers: "{}",
        implants: "[]",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const url = `/api/screenings/${screening.id}/review`;
    const payload = { status: "clear", note: "Device confirmed MR-conditional" };

    const frontDesk = await login("frontdesk@lakeshore.example");
    const denied = await app.inject({
      method: "POST",
      url,
      payload,
      headers: { cookie: frontDesk, "x-clinicvoice-csrf": "1" },
    });
    expect(denied.statusCode).toBe(403);

    const tech = await login("tech@lakeshore.example");
    const noCsrf = await app.inject({ method: "POST", url, payload, headers: { cookie: tech } });
    expect(noCsrf.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url,
      payload,
      headers: { cookie: tech, "x-clinicvoice-csrf": "1" },
    });
    expect(ok.statusCode).toBe(200);
    const row = await db
      .selectFrom("screenings")
      .select(["status", "reviewed_by"])
      .where("id", "=", screening.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("clear");
    expect(row.reviewed_by).not.toBeNull();
    const audit = await db
      .selectFrom("audit_log")
      .select("action")
      .where("entity_id", "=", screening.id)
      .execute();
    expect(audit.map((a) => a.action)).toContain("review");
  });

  it("runs the post-call summary job: summary stored, follow-up task created, usage recorded", async () => {
    const call = await db
      .insertInto("calls")
      .values({ twilio_sid: `CA-it-${Date.now()}` })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("call_turns")
      .values([
        {
          call_id: call.id,
          seq: 1,
          role: "caller",
          text: "Is contrast safe for my kidneys?",
          state: "verify_identity",
        },
        {
          call_id: call.id,
          seq: 2,
          role: "agent",
          text: "I'll have our team call you back.",
          state: "verify_identity",
        },
      ])
      .execute();
    const usage = new PostgresUsageRepository(db);
    const before = await usage.tokensUsedToday("America/Toronto");

    await new PostgresJobQueue(db).enqueue(
      "call_summary",
      { callId: call.id },
      { dedupeKey: `summary:${call.id}` },
    );
    // A duplicate enqueue is ignored.
    await new PostgresJobQueue(db).enqueue(
      "call_summary",
      { callId: call.id },
      { dedupeKey: `summary:${call.id}` },
    );
    const worker = new JobWorker(
      db,
      createJobHandlers({
        db,
        model: fakeStructured,
        usage,
        logger: silentLogger,
        prompts: { callSummary: "x", implantExtract: "y" },
      }),
      silentLogger,
    );
    expect(await worker.drain()).toBe(1);

    const stored = await db
      .selectFrom("calls")
      .select(["summary", "outcome"])
      .where("id", "=", call.id)
      .executeTakeFirstOrThrow();
    expect(stored.outcome).toBe("callback_needed");
    expect(stored.summary).toMatchObject({
      intent: "general_question",
      prompt_version: "call-summary.v1",
    });
    const tasks = await db
      .selectFrom("tasks")
      .select(["type", "reason"])
      .where("call_id", "=", call.id)
      .execute();
    expect(tasks).toEqual([{ type: "callback", reason: "Caller asked about contrast" }]);
    expect(await usage.tokensUsedToday("America/Toronto")).toBe(before + 580);
  });

  it("serves call detail to staff and audits the read", async () => {
    const call = await db.selectFrom("calls").select("id").executeTakeFirstOrThrow();
    const cookie = await login("admin@lakeshore.example");
    const res = await app.inject({
      method: "GET",
      url: `/api/calls/${call.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: call.id, turns: expect.any(Array) });
    const audit = await db
      .selectFrom("audit_log")
      .select("actor")
      .where("entity", "=", "call")
      .where("entity_id", "=", call.id)
      .execute();
    expect(audit.some((a) => a.actor.startsWith("staff:"))).toBe(true);
  });
});
