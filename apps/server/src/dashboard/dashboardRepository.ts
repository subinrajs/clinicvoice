import type { Db } from "@clinicvoice/db";
import type { ScreeningStatus, StaffRole, TaskStatus } from "@clinicvoice/shared";
import { sql } from "kysely";

export interface StaffUser {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
  passwordHash: string;
}

/** Read models for the staff dashboard. Patient names are shown to authenticated staff only. */
export class DashboardRepository {
  constructor(private readonly db: Db) {}

  async findStaffByEmail(email: string): Promise<StaffUser | undefined> {
    const row = await this.db
      .selectFrom("staff_users")
      .select(["id", "email", "display_name", "role", "password_hash"])
      .where("email", "=", email.toLowerCase().trim())
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role as StaffRole,
          passwordHash: row.password_hash,
        }
      : undefined;
  }

  async metrics(timeZone: string) {
    const today = sql<boolean>`(started_at at time zone ${timeZone})::date = (now() at time zone ${timeZone})::date`;
    const calls = await this.db
      .selectFrom("calls")
      .select([
        sql<string>`count(*)`.as("total"),
        sql<string>`count(*) filter (where verified_patient_id is not null)`.as("verified"),
        sql<string>`count(*) filter (where end_reason = 'transfer' or outcome in ('callback_needed','transferred'))`.as(
          "escalated",
        ),
        sql<string>`count(*) filter (where flagged)`.as("flagged"),
      ])
      .where(today)
      .executeTakeFirstOrThrow();
    const latency = await this.db
      .selectFrom("call_turns")
      .select(
        sql<string | null>`percentile_cont(0.5) within group (order by latency_ms)`.as("median"),
      )
      .where("latency_ms", "is not", null)
      .where("created_at", ">=", sql<Date>`now() - interval '24 hours'`)
      .executeTakeFirstOrThrow();
    const openTasks = await this.db
      .selectFrom("tasks")
      .select(sql<string>`count(*)`.as("n"))
      .where("status", "!=", "done")
      .executeTakeFirstOrThrow();
    const reviewQueue = await this.db
      .selectFrom("screenings")
      .select(sql<string>`count(*)`.as("n"))
      .where("status", "=", "needs_review")
      .executeTakeFirstOrThrow();
    return {
      callsToday: Number(calls.total),
      verifiedToday: Number(calls.verified),
      escalatedToday: Number(calls.escalated),
      flaggedToday: Number(calls.flagged),
      medianLatencyMs24h: latency.median === null ? null : Math.round(Number(latency.median)),
      openTasks: Number(openTasks.n),
      screeningsNeedingReview: Number(reviewQueue.n),
    };
  }

  async listCalls(options: { limit: number; before?: Date; flaggedOnly?: boolean }) {
    let q = this.db
      .selectFrom("calls as c")
      .leftJoin("patients as p", "p.id", "c.verified_patient_id")
      .select([
        "c.id",
        "c.started_at",
        "c.ended_at",
        "c.outcome",
        "c.end_reason",
        "c.flagged",
        "c.median_latency_ms",
        "c.language",
        sql<string | null>`c.summary->>'summary'`.as("summary"),
        sql<string | null>`c.summary->>'intent'`.as("intent"),
        sql<
          string | null
        >`case when p.id is null then null else p.first_name || ' ' || p.last_name end`.as(
          "patient_name",
        ),
      ])
      .orderBy("c.started_at", "desc")
      .limit(options.limit);
    if (options.before) q = q.where("c.started_at", "<", options.before);
    if (options.flaggedOnly) q = q.where("c.flagged", "=", true);
    return q.execute();
  }

  async getCall(callId: string) {
    const call = await this.db
      .selectFrom("calls as c")
      .leftJoin("patients as p", "p.id", "c.verified_patient_id")
      .select([
        "c.id",
        "c.started_at",
        "c.ended_at",
        "c.outcome",
        "c.end_reason",
        "c.flagged",
        "c.median_latency_ms",
        "c.language",
        "c.summary",
        "c.verified_patient_id",
        sql<
          string | null
        >`case when p.id is null then null else p.first_name || ' ' || p.last_name end`.as(
          "patient_name",
        ),
      ])
      .where("c.id", "=", callId)
      .executeTakeFirst();
    if (!call) return undefined;
    const turns = await this.db
      .selectFrom("call_turns")
      .select([
        "seq",
        "role",
        "text",
        "tool_name",
        "tool_input",
        "tool_result",
        "state",
        "latency_ms",
        "created_at",
      ])
      .where("call_id", "=", callId)
      .orderBy("seq")
      .execute();
    const tasks = await this.db
      .selectFrom("tasks")
      .select(["id", "type", "reason", "status", "assigned_role", "created_at"])
      .where("call_id", "=", callId)
      .execute();
    return { ...call, turns, tasks };
  }

  async listScreenings(status: ScreeningStatus | "all") {
    let q = this.db
      .selectFrom("screenings as s")
      .innerJoin("appointments as a", "a.id", "s.appointment_id")
      .innerJoin("patients as p", "p.id", "a.patient_id")
      .innerJoin("slots as sl", "sl.id", "a.slot_id")
      .innerJoin("sites as site", "site.id", "sl.site_id")
      .select([
        "s.id",
        "s.status",
        "s.answers",
        "s.implants",
        "s.rules_version",
        "s.review_note",
        "s.reviewed_at",
        "s.updated_at",
        "a.ref as appointment_ref",
        "a.exam_code",
        "sl.starts_at",
        "site.name as site_name",
        sql<string>`p.first_name || ' ' || p.last_name`.as("patient_name"),
      ])
      .orderBy("sl.starts_at");
    if (status !== "all") q = q.where("s.status", "=", status);
    return q.execute();
  }

  /** Technologist decision. Returns false if the screening does not exist. */
  async reviewScreening(
    id: string,
    decision: { status: ScreeningStatus; note: string | null; staffId: string },
  ) {
    const result = await this.db
      .updateTable("screenings")
      .set({
        status: decision.status,
        review_note: decision.note,
        reviewed_by: decision.staffId,
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) return false;
    if (decision.status !== "needs_review") {
      await this.db
        .updateTable("tasks")
        .set({ status: "done", updated_at: new Date() })
        .where("screening_id", "=", id)
        .where("type", "=", "review")
        .execute();
    }
    return true;
  }

  async listTasks(status: TaskStatus | "active") {
    let q = this.db
      .selectFrom("tasks as t")
      .leftJoin("patients as p", "p.id", "t.patient_id")
      .select([
        "t.id",
        "t.type",
        "t.reason",
        "t.status",
        "t.assigned_role",
        "t.call_id",
        "t.screening_id",
        "t.created_at",
        sql<
          string | null
        >`case when p.id is null then null else p.first_name || ' ' || p.last_name end`.as(
          "patient_name",
        ),
        "p.phone_e164 as patient_phone",
      ])
      .orderBy("t.created_at", "desc")
      .limit(200);
    q = status === "active" ? q.where("t.status", "!=", "done") : q.where("t.status", "=", status);
    return q.execute();
  }

  async updateTask(id: string, status: TaskStatus) {
    const result = await this.db
      .updateTable("tasks")
      .set({ status, updated_at: new Date() })
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async schedule(range: { from: Date; to: Date; siteCode?: string }) {
    let q = this.db
      .selectFrom("slots as s")
      .innerJoin("sites as site", "site.id", "s.site_id")
      .leftJoin("appointments as a", (join) =>
        join.onRef("a.slot_id", "=", "s.id").on("a.status", "=", "booked"),
      )
      .leftJoin("patients as p", "p.id", "a.patient_id")
      .select([
        "s.id",
        "s.starts_at",
        "s.duration_min",
        "s.modality",
        sql<string>`case when s.status = 'held' and s.held_until < now() then 'open' else s.status end`.as(
          "status",
        ),
        "site.code as site_code",
        "site.name as site_name",
        "a.ref as appointment_ref",
        "a.exam_code",
        "a.created_via",
        sql<
          string | null
        >`case when p.id is null then null else p.first_name || ' ' || p.last_name end`.as(
          "patient_name",
        ),
      ])
      .where("s.starts_at", ">=", range.from)
      .where("s.starts_at", "<", range.to)
      .orderBy("site.code")
      .orderBy("s.modality")
      .orderBy("s.starts_at");
    if (range.siteCode) q = q.where("site.code", "=", range.siteCode);
    return q.execute();
  }
}
