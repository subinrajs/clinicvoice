/**
 * Runs against a real Postgres (docker compose) when TEST_DATABASE_URL (app role) and
 * TEST_DATABASE_MIGRATION_URL (owner) are set; skipped otherwise. Reseeds the database.
 */
import { createDb, migrate, type Db } from "@clinicvoice/db";
import { seed } from "@clinicvoice/db/seed";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuditWriter } from "../../src/repositories/auditRepository.js";
import { PostgresClinicRepository } from "../../src/repositories/clinicRepository.js";
import { RisRepository } from "../../src/repositories/risRepository.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe.skipIf(!appUrl || !ownerUrl)("database integration", () => {
  let app: Db;
  let owner: Db;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    owner = createDb({ connectionString: ownerUrl!, maxConnections: 2 });
    await seed(owner);
    app = createDb({ connectionString: appUrl!, maxConnections: 5 });
  });

  afterAll(async () => {
    await app?.destroy();
    await owner?.destroy();
  });

  it("finds the demo patient by DOB and phone last 4", async () => {
    const repo = new PostgresClinicRepository(app);
    const candidates = await repo.findIdentityCandidates("1984-03-12", "0121");
    expect(candidates).toEqual([
      expect.objectContaining({ firstName: "Maria", lastName: "Santos" }),
    ]);
  });

  it("lets the app insert audit events but never update or delete them", async () => {
    await new PostgresAuditWriter(app).write({
      actor: "test",
      action: "read",
      entity: "patient",
      entityId: "x",
    });
    await expect(sql`update audit_log set actor = 'tampered'`.execute(app)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`delete from audit_log`.execute(app)).rejects.toThrow(/permission denied/);
  });

  it("never lets two callers hold or book the same slot", async () => {
    const ris = new RisRepository(app);
    const [slot] = await ris.searchSlots({
      modality: "MRI",
      from: new Date(),
      to: new Date(Date.now() + 14 * 864e5),
      limit: 1,
    });
    expect(slot).toBeDefined();
    const holds = await Promise.all([ris.holdSlot(slot!.id, null), ris.holdSlot(slot!.id, null)]);
    expect(holds.filter((h) => h.ok)).toHaveLength(1);
  });

  it("books a held slot and reschedules atomically", async () => {
    const ris = new RisRepository(app);
    const patient = await app
      .selectFrom("patients")
      .select("id")
      .where("last_name", "=", "Santos")
      .executeTakeFirstOrThrow();
    const existing = await app
      .selectFrom("appointments")
      .select(["id", "slot_id", "exam_code", "requisition_id"])
      .where("patient_id", "=", patient.id)
      .where("status", "=", "booked")
      .executeTakeFirstOrThrow();
    const call = await app
      .insertInto("calls")
      .values({ twilio_sid: `CA-test-${Date.now()}` })
      .returning("id")
      .executeTakeFirstOrThrow();

    const [slot] = await ris.searchSlots({
      modality: "MRI",
      from: new Date(Date.now() + 2 * 864e5),
      to: new Date(Date.now() + 14 * 864e5),
      limit: 1,
    });
    expect((await ris.holdSlot(slot!.id, call.id)).ok).toBe(true);

    const booked = await ris.bookSlot({
      slotId: slot!.id,
      patientId: patient.id,
      examCode: existing.exam_code,
      contrast: false,
      requisitionId: existing.requisition_id,
      heldByCall: call.id,
      createdVia: "voice",
      replacesAppointmentId: existing.id,
    });
    expect(booked).toMatchObject({ ok: true, value: { ref: expect.stringMatching(/^A\d{4,}$/) } });

    const old = await app
      .selectFrom("appointments")
      .select("status")
      .where("id", "=", existing.id)
      .executeTakeFirstOrThrow();
    const freed = await app
      .selectFrom("slots")
      .select("status")
      .where("id", "=", existing.slot_id)
      .executeTakeFirstOrThrow();
    expect(old.status).toBe("cancelled");
    expect(freed.status).toBe("open");

    // A different call cannot book on someone else's hold.
    const again = await ris.bookSlot({
      slotId: slot!.id,
      patientId: patient.id,
      examCode: "MRI_KNEE",
      contrast: false,
      requisitionId: null,
      heldByCall: "00000000-0000-0000-0000-000000000000",
      createdVia: "voice",
    });
    expect(again).toEqual({ ok: false, reason: "SLOT_TAKEN" });
  });

  it("refuses to cancel another patient's appointment", async () => {
    const ris = new RisRepository(app);
    const someone = await app
      .selectFrom("appointments")
      .select("id")
      .where("status", "=", "booked")
      .executeTakeFirstOrThrow();
    const result = await ris.cancelAppointment(
      someone.id,
      "00000000-0000-0000-0000-000000000000",
      "test",
    );
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });
});
