import type { Db } from "@clinicvoice/db";
import type { Language } from "@clinicvoice/shared";

export interface PrepTemplate {
  id: string;
  body: string;
  version: number;
}

/** Approved prep templates and the outbound message log. */
export interface MessagingPort {
  /** Latest approved version only: the agent can never send unapproved wording. */
  findApprovedTemplate(examCode: string, language: Language): Promise<PrepTemplate | undefined>;
  getPatientPhone(patientId: string): Promise<string | null>;
  recordMessage(entry: {
    patientId: string;
    templateId: string;
    providerSid: string | null;
    status: string;
  }): Promise<{ id: string }>;
}

export class PostgresMessagingRepository implements MessagingPort {
  constructor(private readonly db: Db) {}

  async findApprovedTemplate(examCode: string, language: Language) {
    return this.db
      .selectFrom("prep_templates")
      .select(["id", "body", "version"])
      .where("exam_code", "=", examCode)
      .where("language", "=", language)
      .where("approved", "=", true)
      .orderBy("version", "desc")
      .executeTakeFirst();
  }

  async getPatientPhone(patientId: string) {
    const row = await this.db
      .selectFrom("patients")
      .select("phone_e164")
      .where("id", "=", patientId)
      .executeTakeFirst();
    return row?.phone_e164 ?? null;
  }

  async recordMessage(entry: {
    patientId: string;
    templateId: string;
    providerSid: string | null;
    status: string;
  }) {
    return this.db
      .insertInto("messages")
      .values({
        patient_id: entry.patientId,
        template_id: entry.templateId,
        channel: "sms",
        sent_at: new Date(),
        provider_sid: entry.providerSid,
        status: entry.status,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  }
}
