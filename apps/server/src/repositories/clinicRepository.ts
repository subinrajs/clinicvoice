import type { Db } from "@clinicvoice/db";
import type { TaskType, StaffRole } from "@clinicvoice/shared";

export interface SiteInfo {
  code: string;
  name: string;
  address: string;
  modalities: string[];
  hours: Record<string, string | null>;
  parking: string;
}

export interface IdentityCandidate {
  id: string;
  firstName: string;
  lastName: string;
  preferredLanguage: string;
}

export interface UpcomingAppointment {
  id: string;
  ref: string;
  examCode: string;
  modality: string;
  siteName: string;
  startsAt: Date;
}

/** Data access the voice tools need. Implemented over Postgres; faked in unit tests. */
export interface ClinicRepository {
  listSites(): Promise<SiteInfo[]>;
  findIdentityCandidates(dob: string, phoneLast4: string): Promise<IdentityCandidate[]>;
  countRecentIdentityFailures(filter: {
    patientIds: string[];
    fromHash: string | null;
    since: Date;
  }): Promise<number>;
  recordIdentityFailure(entry: {
    patientId: string | null;
    fromHash: string | null;
    callId: string;
  }): Promise<void>;
  markCallVerified(callId: string, patientId: string): Promise<void>;
  listUpcomingAppointments(patientId: string, now: Date): Promise<UpcomingAppointment[]>;
  createTask(task: {
    type: TaskType;
    callId: string;
    patientId: string | null;
    reason: string;
    assignedRole: StaffRole;
  }): Promise<{ id: string }>;
}

export class PostgresClinicRepository implements ClinicRepository {
  constructor(private readonly db: Db) {}

  async listSites(): Promise<SiteInfo[]> {
    const rows = await this.db
      .selectFrom("sites")
      .select(["code", "name", "address", "modalities", "hours", "parking"])
      .orderBy("code")
      .execute();
    return rows.map((r) => ({ ...r, hours: r.hours as unknown as Record<string, string | null> }));
  }

  async findIdentityCandidates(dob: string, phoneLast4: string): Promise<IdentityCandidate[]> {
    const rows = await this.db
      .selectFrom("patients")
      .select(["id", "first_name", "last_name", "preferred_language"])
      .where("dob", "=", dob)
      .where("phone_last4", "=", phoneLast4)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      preferredLanguage: r.preferred_language,
    }));
  }

  async countRecentIdentityFailures(filter: {
    patientIds: string[];
    fromHash: string | null;
    since: Date;
  }): Promise<number> {
    if (filter.patientIds.length === 0 && !filter.fromHash) return 0;
    const row = await this.db
      .selectFrom("identity_failures")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("at", ">=", filter.since)
      .where((eb) =>
        eb.or([
          ...(filter.patientIds.length ? [eb("patient_id", "in", filter.patientIds)] : []),
          ...(filter.fromHash ? [eb("from_hash", "=", filter.fromHash)] : []),
        ]),
      )
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async recordIdentityFailure(entry: {
    patientId: string | null;
    fromHash: string | null;
    callId: string;
  }) {
    await this.db
      .insertInto("identity_failures")
      .values({ patient_id: entry.patientId, from_hash: entry.fromHash, call_id: entry.callId })
      .execute();
  }

  async markCallVerified(callId: string, patientId: string) {
    await this.db
      .updateTable("calls")
      .set({ verified_patient_id: patientId })
      .where("id", "=", callId)
      .execute();
  }

  async listUpcomingAppointments(patientId: string, now: Date): Promise<UpcomingAppointment[]> {
    const rows = await this.db
      .selectFrom("appointments as a")
      .innerJoin("slots as s", "s.id", "a.slot_id")
      .innerJoin("sites as site", "site.id", "s.site_id")
      .select([
        "a.id",
        "a.ref",
        "a.exam_code",
        "s.modality",
        "site.name as site_name",
        "s.starts_at",
      ])
      .where("a.patient_id", "=", patientId)
      .where("a.status", "=", "booked")
      .where("s.starts_at", ">=", now)
      .orderBy("s.starts_at")
      .limit(5)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      examCode: r.exam_code,
      modality: r.modality,
      siteName: r.site_name,
      startsAt: r.starts_at,
    }));
  }

  async createTask(task: {
    type: TaskType;
    callId: string;
    patientId: string | null;
    reason: string;
    assignedRole: StaffRole;
  }) {
    return this.db
      .insertInto("tasks")
      .values({
        type: task.type,
        call_id: task.callId,
        patient_id: task.patientId,
        reason: task.reason,
        assigned_role: task.assignedRole,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  }
}
