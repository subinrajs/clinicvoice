import type { Db } from "@clinicvoice/db";
import type { Modality } from "@clinicvoice/shared";
import { sql } from "kysely";

export interface SlotView {
  id: string;
  siteCode: string;
  siteName: string;
  modality: string;
  startsAt: Date;
  durationMin: number;
}

export type RisResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "SLOT_TAKEN" | "HOLD_EXPIRED" | "NOT_FOUND" | "NOT_BOOKED" };

export interface PatientAppointment {
  id: string;
  examCode: string;
  contrast: boolean;
  modality: string;
  siteName: string;
  startsAt: Date;
  status: string;
  requisitionId: string | null;
}

export interface Requisition {
  id: string;
  examCode: string;
  modality: string;
  contrast: boolean;
  status: string;
}

export interface BookInput {
  slotId: string;
  patientId: string;
  examCode: string;
  contrast: boolean;
  requisitionId: string | null;
  heldByCall: string | null;
  createdVia: "voice" | "staff";
  replacesAppointmentId?: string;
}

/** What the booking tools need from the RIS. Implemented by RisRepository; faked in unit tests. */
export interface SchedulingPort {
  searchSlots(query: {
    modality: Modality;
    siteCode?: string;
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<SlotView[]>;
  getSlot(slotId: string): Promise<SlotView | undefined>;
  holdSlot(
    slotId: string,
    callId: string | null,
    minutes?: number,
  ): Promise<RisResult<{ heldUntil: Date }>>;
  releaseHold(slotId: string, callId: string): Promise<void>;
  bookSlot(
    input: BookInput,
  ): Promise<RisResult<{ appointmentId: string; ref: string; startsAt: Date }>>;
  cancelAppointment(
    appointmentId: string,
    patientId: string,
    reason: string,
  ): Promise<RisResult<{ cancelled: true }>>;
  getPatientAppointment(
    patientId: string,
    appointmentId: string,
  ): Promise<PatientAppointment | undefined>;
  /** The patient's open requisition for a modality, else a scheduled one (for reschedules). */
  findRequisition(patientId: string, modality: Modality): Promise<Requisition | undefined>;
}

const DEFAULT_HOLD_MINUTES = 5;

/** A held slot whose hold has lapsed counts as open. Correctness never depends on a cleanup job. */
const isAvailable = sql<boolean>`(s.status = 'open' OR (s.status = 'held' AND s.held_until < now()))`;

/**
 * Stand-in for a radiology information system. All state transitions lock the slot row
 * (SELECT ... FOR UPDATE) so two callers can never book the same slot.
 */
export class RisRepository implements SchedulingPort {
  constructor(private readonly db: Db) {}

  async searchSlots(query: {
    modality: Modality;
    siteCode?: string;
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<SlotView[]> {
    let q = this.db
      .selectFrom("slots as s")
      .innerJoin("sites as site", "site.id", "s.site_id")
      .select(["s.id", "site.code", "site.name", "s.modality", "s.starts_at", "s.duration_min"])
      .where("s.modality", "=", query.modality)
      .where("s.starts_at", ">=", query.from)
      .where("s.starts_at", "<", query.to)
      .where(isAvailable)
      .orderBy("s.starts_at")
      .limit(Math.min(query.limit ?? 5, 20));
    if (query.siteCode) q = q.where("site.code", "=", query.siteCode);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      siteCode: r.code,
      siteName: r.name,
      modality: r.modality,
      startsAt: r.starts_at,
      durationMin: r.duration_min,
    }));
  }

  async holdSlot(
    slotId: string,
    callId: string | null,
    minutes = DEFAULT_HOLD_MINUTES,
  ): Promise<RisResult<{ heldUntil: Date }>> {
    const row = await this.db
      .updateTable("slots as s")
      .set({
        status: "held",
        held_until: sql<Date>`now() + make_interval(mins => ${minutes})`,
        held_by_call: callId,
      })
      .where("s.id", "=", slotId)
      .where(isAvailable)
      .returning("s.held_until")
      .executeTakeFirst();
    return row?.held_until
      ? { ok: true, value: { heldUntil: row.held_until } }
      : { ok: false, reason: "SLOT_TAKEN" };
  }

  /**
   * Books a slot held by this call (or an open slot, for staff). When `replacesAppointmentId` is
   * given, the old appointment is cancelled in the same transaction: a reschedule is atomic.
   */
  async bookSlot(
    input: BookInput,
  ): Promise<RisResult<{ appointmentId: string; ref: string; startsAt: Date }>> {
    return this.db.transaction().execute(async (trx) => {
      const slot = await trx
        .selectFrom("slots")
        .select(["id", "status", "held_until", "held_by_call", "starts_at"])
        .where("id", "=", input.slotId)
        .forUpdate()
        .executeTakeFirst();
      if (!slot) return { ok: false, reason: "NOT_FOUND" } as const;

      const holdValid =
        slot.status === "held" &&
        slot.held_until !== null &&
        slot.held_until > new Date() &&
        slot.held_by_call === input.heldByCall;
      const openForStaff = input.createdVia === "staff" && slot.status === "open";
      if (!holdValid && !openForStaff) {
        return {
          ok: false,
          reason: slot.status === "booked" ? "SLOT_TAKEN" : "HOLD_EXPIRED",
        } as const;
      }

      if (input.replacesAppointmentId) {
        const cancelled = await this.cancelWithin(
          trx,
          input.replacesAppointmentId,
          input.patientId,
          "rescheduled",
        );
        if (!cancelled.ok) return cancelled;
      }

      await trx
        .updateTable("slots")
        .set({ status: "booked", held_until: null, held_by_call: null })
        .where("id", "=", slot.id)
        .execute();
      const appointment = await trx
        .insertInto("appointments")
        .values({
          ref: sql<string>`'A' || nextval('appointment_ref_seq')`,
          patient_id: input.patientId,
          requisition_id: input.requisitionId,
          slot_id: slot.id,
          exam_code: input.examCode,
          contrast: input.contrast,
          status: "booked",
          created_via: input.createdVia,
        })
        .returning(["id", "ref"])
        .executeTakeFirstOrThrow();
      if (input.requisitionId) {
        await trx
          .updateTable("requisitions")
          .set({ status: "scheduled" })
          .where("id", "=", input.requisitionId)
          .execute();
      }
      return {
        ok: true,
        value: { appointmentId: appointment.id, ref: appointment.ref, startsAt: slot.starts_at },
      } as const;
    });
  }

  async cancelAppointment(
    appointmentId: string,
    patientId: string,
    reason: string,
  ): Promise<RisResult<{ cancelled: true }>> {
    return this.db
      .transaction()
      .execute((trx) => this.cancelWithin(trx, appointmentId, patientId, reason));
  }

  private async cancelWithin(
    trx: Db,
    appointmentId: string,
    patientId: string,
    reason: string,
  ): Promise<RisResult<{ cancelled: true }>> {
    const appointment = await trx
      .selectFrom("appointments")
      .select(["id", "slot_id", "status", "requisition_id"])
      .where("id", "=", appointmentId)
      // Scoped to the patient: one caller can never cancel another patient's booking.
      .where("patient_id", "=", patientId)
      .forUpdate()
      .executeTakeFirst();
    if (!appointment) return { ok: false, reason: "NOT_FOUND" };
    if (appointment.status !== "booked") return { ok: false, reason: "NOT_BOOKED" };

    await trx
      .updateTable("appointments")
      .set({ status: "cancelled", cancel_reason: reason })
      .where("id", "=", appointment.id)
      .execute();
    await trx
      .updateTable("slots")
      .set({ status: "open", held_until: null, held_by_call: null })
      .where("id", "=", appointment.slot_id)
      .execute();
    if (appointment.requisition_id) {
      await trx
        .updateTable("requisitions")
        .set({ status: "open" })
        .where("id", "=", appointment.requisition_id)
        .execute();
    }
    return { ok: true, value: { cancelled: true } };
  }

  async getSlot(slotId: string): Promise<SlotView | undefined> {
    const row = await this.db
      .selectFrom("slots as s")
      .innerJoin("sites as site", "site.id", "s.site_id")
      .select(["s.id", "site.code", "site.name", "s.modality", "s.starts_at", "s.duration_min"])
      .where("s.id", "=", slotId)
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          siteCode: row.code,
          siteName: row.name,
          modality: row.modality,
          startsAt: row.starts_at,
          durationMin: row.duration_min,
        }
      : undefined;
  }

  async releaseHold(slotId: string, callId: string): Promise<void> {
    await this.db
      .updateTable("slots")
      .set({ status: "open", held_until: null, held_by_call: null })
      .where("id", "=", slotId)
      .where("status", "=", "held")
      .where("held_by_call", "=", callId)
      .execute();
  }

  async getPatientAppointment(
    patientId: string,
    appointmentId: string,
  ): Promise<PatientAppointment | undefined> {
    const row = await this.db
      .selectFrom("appointments as a")
      .innerJoin("slots as s", "s.id", "a.slot_id")
      .innerJoin("sites as site", "site.id", "s.site_id")
      .select([
        "a.id",
        "a.exam_code",
        "a.contrast",
        "s.modality",
        "site.name as site_name",
        "s.starts_at",
        "a.status",
        "a.requisition_id",
      ])
      .where("a.id", "=", appointmentId)
      // Scoped to the verified patient: refs from another session can never reach someone else's data.
      .where("a.patient_id", "=", patientId)
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          examCode: row.exam_code,
          contrast: row.contrast,
          modality: row.modality,
          siteName: row.site_name,
          startsAt: row.starts_at,
          status: row.status,
          requisitionId: row.requisition_id,
        }
      : undefined;
  }

  async findRequisition(patientId: string, modality: Modality): Promise<Requisition | undefined> {
    const row = await this.db
      .selectFrom("requisitions")
      .select(["id", "exam_code", "modality", "contrast", "status"])
      .where("patient_id", "=", patientId)
      .where("modality", "=", modality)
      .where("status", "in", ["open", "scheduled"])
      // Prefer an unscheduled order; fall back to a scheduled one (a reschedule).
      .orderBy(sql`case when status = 'open' then 0 else 1 end`)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          examCode: row.exam_code,
          modality: row.modality,
          contrast: row.contrast,
          status: row.status,
        }
      : undefined;
  }

  /** Housekeeping only (keeps the dashboard tidy); availability checks already ignore lapsed holds. */
  async releaseExpiredHolds(): Promise<number> {
    const result = await this.db
      .updateTable("slots")
      .set({ status: "open", held_until: null, held_by_call: null })
      .where("status", "=", "held")
      .where("held_until", "<", new Date())
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
