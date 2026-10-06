import type { Db } from "@clinicvoice/db";
import type { ScreeningAnswer, ScreeningStatus } from "@clinicvoice/shared";

export interface RecordedAnswer {
  answer: ScreeningAnswer;
  /** The caller's exact words, kept verbatim for the technologist. */
  callerWords: string | null;
  at: string;
}

export interface ImplantEntry {
  device: string;
  bodyLocation: string | null;
  /** Verbatim quote from the caller; never paraphrased. */
  callerWords: string;
  needsFollowUp: boolean;
}

export interface Screening {
  id: string;
  appointmentId: string;
  answers: Record<string, RecordedAnswer>;
  implants: ImplantEntry[];
  rulesVersion: string;
  status: ScreeningStatus;
}

export interface ScreeningPort {
  getOrCreate(appointmentId: string, rulesVersion: string): Promise<Screening>;
  saveAnswers(
    screeningId: string,
    answers: Record<string, RecordedAnswer>,
    status: ScreeningStatus,
  ): Promise<void>;
  saveImplants(screeningId: string, implants: ImplantEntry[]): Promise<void>;
}

type Row = {
  id: string;
  appointment_id: string;
  answers: unknown;
  implants: unknown;
  rules_version: string;
  status: string;
};

function toScreening(row: Row): Screening {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    answers: (row.answers ?? {}) as Record<string, RecordedAnswer>,
    implants: (row.implants ?? []) as ImplantEntry[],
    rulesVersion: row.rules_version,
    status: row.status as ScreeningStatus,
  };
}

export class PostgresScreeningRepository implements ScreeningPort {
  constructor(private readonly db: Db) {}

  async getOrCreate(appointmentId: string, rulesVersion: string): Promise<Screening> {
    const columns = [
      "id",
      "appointment_id",
      "answers",
      "implants",
      "rules_version",
      "status",
    ] as const;
    const inserted = await this.db
      .insertInto("screenings")
      .values({
        appointment_id: appointmentId,
        rules_version: rulesVersion,
        status: "in_progress",
        answers: "{}",
        implants: "[]",
      })
      .onConflict((oc) => oc.column("appointment_id").doNothing())
      .returning(columns)
      .executeTakeFirst();
    const row =
      inserted ??
      (await this.db
        .selectFrom("screenings")
        .select(columns)
        .where("appointment_id", "=", appointmentId)
        .executeTakeFirstOrThrow());
    return toScreening(row as Row);
  }

  async saveAnswers(
    screeningId: string,
    answers: Record<string, RecordedAnswer>,
    status: ScreeningStatus,
  ) {
    await this.db
      .updateTable("screenings")
      .set({ answers: JSON.stringify(answers), status, updated_at: new Date() })
      .where("id", "=", screeningId)
      // A technologist's decision is final for the agent: never overwrite a reviewed screening.
      .where("status", "in", ["in_progress", "needs_review"])
      .execute();
  }

  async saveImplants(screeningId: string, implants: ImplantEntry[]) {
    await this.db
      .updateTable("screenings")
      .set({ implants: JSON.stringify(implants), updated_at: new Date() })
      .where("id", "=", screeningId)
      .execute();
  }
}
