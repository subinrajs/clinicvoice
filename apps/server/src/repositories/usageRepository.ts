import type { Db } from "@clinicvoice/db";
import { sql } from "kysely";

export interface UsageEntry {
  callId: string | null;
  purpose: "live_turn" | "call_summary" | "implant_extraction" | "grading";
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Records model token usage and answers the daily-budget question used by the spend cap. */
export interface UsageRepository {
  record(entry: UsageEntry): Promise<void>;
  tokensUsedToday(timeZone: string): Promise<number>;
}

export class PostgresUsageRepository implements UsageRepository {
  constructor(private readonly db: Db) {}

  async record(entry: UsageEntry) {
    await this.db
      .insertInto("llm_usage")
      .values({
        call_id: entry.callId,
        purpose: entry.purpose,
        model: entry.model,
        input_tokens: entry.inputTokens,
        cached_input_tokens: entry.cachedInputTokens,
        output_tokens: entry.outputTokens,
      })
      .execute();
  }

  async tokensUsedToday(timeZone: string) {
    const row = await this.db
      .selectFrom("llm_usage")
      .select(sql<string>`coalesce(sum(input_tokens + output_tokens), 0)`.as("total"))
      .where(
        sql<boolean>`(at at time zone ${timeZone})::date = (now() at time zone ${timeZone})::date`,
      )
      .executeTakeFirstOrThrow();
    return Number(row.total);
  }
}
