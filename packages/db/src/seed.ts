/**
 * Resets the database to a deterministic synthetic dataset: 3 sites, 40 patients, two weeks of
 * slots, requisitions, booked appointments, approved EN/FR prep templates and demo staff logins.
 *
 * Destructive: truncates every operational table. Refuses to run in production unless
 * SEED_ALLOW_RESET=1 is set (used by the nightly demo reset).
 */
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { createDb, type Db } from "./client.js";
import { hashPassword } from "./password.js";
import {
  DEMO_PATIENTS,
  EXAMS,
  FIRST_NAMES,
  LAST_NAMES,
  PREP_TEMPLATES,
  SITES,
  SLOT_MINUTES,
} from "./seedData.js";
import { zonedWallTimeToUtc } from "./time.js";

const TOTAL_PATIENTS = 40;
const SLOT_DAYS = 14;
const TIME_ZONE = process.env.CLINIC_TIMEZONE ?? "America/Toronto";

/** Mulberry32: tiny seeded PRNG so every seed run produces the same dataset. */
function createRng(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    /** Fisher-Yates shuffle into a new array. */
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}

type Rng = ReturnType<typeof createRng>;

interface SeedPatient {
  first: string;
  last: string;
  dob: string;
  phone: string;
  lang: "en" | "fr";
  exam: (typeof EXAMS)[number]["code"];
  booked: boolean;
}

function buildPatients(rng: Rng): SeedPatient[] {
  const patients: SeedPatient[] = DEMO_PATIENTS.map((p) => ({ ...p }));
  for (let i = patients.length; i < TOTAL_PATIENTS; i++) {
    const year = rng.int(1945, 2004);
    const month = String(rng.int(1, 12)).padStart(2, "0");
    const day = String(rng.int(1, 28)).padStart(2, "0");
    patients.push({
      first: FIRST_NAMES[i % FIRST_NAMES.length] as string,
      last: LAST_NAMES[(i * 7) % LAST_NAMES.length] as string,
      dob: `${year}-${month}-${day}`,
      // 555-0100..0199 is reserved for fiction; keep every number in it.
      phone: `+1416555${String(100 + i).padStart(4, "0")}`,
      lang: rng.next() < 0.15 ? "fr" : "en",
      exam: rng.pick(EXAMS).code,
      booked: rng.next() < 0.6,
    });
  }
  return patients;
}

function localDay(offsetDays: number): {
  year: number;
  month: number;
  day: number;
  isoWeekday: number;
} {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = parts.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + offsetDays));
  const weekday = date.getUTCDay();
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    isoWeekday: weekday === 0 ? 7 : weekday,
  };
}

async function truncateAll(db: Db): Promise<void> {
  // audit_log is truncated only by the owner role, which is what the seed runs as.
  await sql`
    TRUNCATE audit_log, messages, prep_templates, tasks, screenings, identity_failures,
      call_turns, calls, appointments, slots, requisitions, patients, staff_users, sites
    RESTART IDENTITY CASCADE
  `.execute(db);
}

export async function seed(db: Db): Promise<Record<string, number>> {
  const rng = createRng(20261005);

  return db.transaction().execute(async (trx) => {
    await truncateAll(trx);

    const sites = await trx
      .insertInto("sites")
      .values(
        SITES.map((s) => ({
          code: s.code,
          name: s.name,
          address: s.address,
          modalities: [...s.modalities],
          hours: JSON.stringify(s.hours),
          parking: s.parking,
        })),
      )
      .returning(["id", "code", "modalities", "hours"])
      .execute();

    // Two weeks of slots, starting tomorrow, inside each site's opening hours.
    const slotRows: { site_id: string; modality: string; starts_at: Date; duration_min: number }[] =
      [];
    for (let offset = 1; offset <= SLOT_DAYS; offset++) {
      const day = localDay(offset);
      for (const site of sites) {
        const window = (site.hours as Record<string, string | null>)[String(day.isoWeekday)];
        if (!window) continue;
        const [open, close] = window.split("-").map((t) => {
          const [h, m] = t.split(":").map(Number) as [number, number];
          return h * 60 + m;
        }) as [number, number];
        for (const modality of site.modalities as ("MRI" | "CT")[]) {
          const step = SLOT_MINUTES[modality];
          for (let minute = open; minute + step <= close; minute += step) {
            slotRows.push({
              site_id: site.id,
              modality,
              starts_at: zonedWallTimeToUtc(
                { ...day, hour: Math.floor(minute / 60), minute: minute % 60 },
                TIME_ZONE,
              ),
              duration_min: step,
            });
          }
        }
      }
    }
    const slots = [];
    for (let i = 0; i < slotRows.length; i += 500) {
      slots.push(
        ...(await trx
          .insertInto("slots")
          .values(slotRows.slice(i, i + 500))
          .returning(["id", "modality", "starts_at"])
          .execute()),
      );
    }

    const seedPatients = buildPatients(rng);
    const patients = await trx
      .insertInto("patients")
      .values(
        seedPatients.map((p) => ({
          first_name: p.first,
          last_name: p.last,
          dob: p.dob,
          phone_e164: p.phone,
          phone_last4: p.phone.slice(-4),
          preferred_language: p.lang,
          health_card_token: `tok_${rng.int(100000, 999999)}`,
        })),
      )
      .returning(["id"])
      .execute();

    const examByCode = new Map(EXAMS.map((e) => [e.code, e]));
    const freeSlots = new Map<string, typeof slots>();
    for (const modality of ["MRI", "CT"]) {
      freeSlots.set(modality, rng.shuffle(slots.filter((s) => s.modality === modality)));
    }

    let appointmentCount = 0;
    for (const [index, patient] of patients.entries()) {
      const seedPatient = seedPatients[index] as SeedPatient;
      const exam = examByCode.get(seedPatient.exam)!;
      const requisition = await trx
        .insertInto("requisitions")
        .values({
          patient_id: patient.id,
          exam_code: exam.code,
          modality: exam.modality,
          contrast: exam.contrast,
          status: seedPatient.booked ? "scheduled" : "open",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      if (!seedPatient.booked) continue;
      const slot = freeSlots.get(exam.modality)!.pop();
      if (!slot) throw new Error(`Ran out of ${exam.modality} slots while seeding`);
      await trx.updateTable("slots").set({ status: "booked" }).where("id", "=", slot.id).execute();
      appointmentCount++;
      await trx
        .insertInto("appointments")
        .values({
          ref: `A${String(1000 + appointmentCount)}`,
          patient_id: patient.id,
          requisition_id: requisition.id,
          slot_id: slot.id,
          exam_code: exam.code,
          contrast: exam.contrast,
          status: "booked",
          created_via: "seed",
        })
        .execute();
    }

    await trx
      .insertInto("prep_templates")
      .values(
        Object.entries(PREP_TEMPLATES).flatMap(([examCode, bodies]) =>
          (["en", "fr"] as const).map((language) => ({
            exam_code: examCode,
            language,
            body: bodies[language],
            version: 1,
            approved: true,
          })),
        ),
      )
      .execute();

    const staffPassword = process.env.SEED_STAFF_PASSWORD ?? "lakeshore-demo";
    const passwordHash = await hashPassword(staffPassword);
    await trx
      .insertInto("staff_users")
      .values([
        {
          email: "frontdesk@lakeshore.example",
          display_name: "Front Desk",
          role: "front_desk",
          password_hash: passwordHash,
        },
        {
          email: "tech@lakeshore.example",
          display_name: "MRI Technologist",
          role: "technologist",
          password_hash: passwordHash,
        },
        {
          email: "admin@lakeshore.example",
          display_name: "Clinic Admin",
          role: "admin",
          password_hash: passwordHash,
        },
      ])
      .execute();

    return {
      sites: sites.length,
      patients: patients.length,
      slots: slots.length,
      appointments: appointmentCount,
      prepTemplates: Object.keys(PREP_TEMPLATES).length * 2,
      staffUsers: 3,
    };
  });
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error("DATABASE_MIGRATION_URL is not set");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_RESET !== "1") {
    console.error("Refusing to reset a production database without SEED_ALLOW_RESET=1");
    process.exit(1);
  }
  const db = createDb({ connectionString: url, maxConnections: 2 });
  seed(db)
    .then((counts) => console.log("Seeded:", counts))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}
