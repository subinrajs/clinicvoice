import type { Db } from "@clinicvoice/db";

export interface AuditEvent {
  actor: string;
  action:
    | "read"
    | "create"
    | "update"
    | "book"
    | "cancel"
    | "hold"
    | "verify"
    | "send"
    | "transfer"
    | "review"
    | "login";
  entity: string;
  entityId: string;
  requestId?: string;
}

/** Appends to the insert-only audit_log. Every read or write of patient data goes through here. */
export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
}

export class PostgresAuditWriter implements AuditWriter {
  constructor(private readonly db: Db) {}

  async write(event: AuditEvent): Promise<void> {
    await this.db
      .insertInto("audit_log")
      .values({
        actor: event.actor,
        action: event.action,
        entity: event.entity,
        entity_id: event.entityId,
        request_id: event.requestId ?? null,
      })
      .execute();
  }
}
