import type { Db } from "@clinicvoice/db";
import type { Logger } from "../lib/logger.js";
import type { TurnRecord } from "../agent/agent.js";

export interface CallRepository {
  startCall(call: { twilioSid: string; fromHash: string | null }): Promise<{ id: string }>;
  endCall(
    callId: string,
    outcome: { medianLatencyMs: number | null; flagged: boolean },
  ): Promise<void>;
  /** Fire-and-forget: queued so persistence never adds latency to a live turn. */
  recordTurn(callId: string, seq: number, turn: TurnRecord): void;
  /** Resolves when all queued turn writes have settled (used on hang-up and in tests). */
  drain(): Promise<void>;
}

export class PostgresCallRepository implements CallRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async startCall(call: { twilioSid: string; fromHash: string | null }) {
    return this.db
      .insertInto("calls")
      .values({ twilio_sid: call.twilioSid, from_hash: call.fromHash })
      .onConflict((oc) => oc.column("twilio_sid").doUpdateSet({ from_hash: call.fromHash }))
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  async endCall(callId: string, outcome: { medianLatencyMs: number | null; flagged: boolean }) {
    await this.drain();
    await this.db
      .updateTable("calls")
      .set({
        ended_at: new Date(),
        median_latency_ms: outcome.medianLatencyMs,
        flagged: outcome.flagged,
      })
      .where("id", "=", callId)
      .execute();
  }

  recordTurn(callId: string, seq: number, turn: TurnRecord): void {
    this.queue = this.queue
      .then(async () => {
        await this.db
          .insertInto("call_turns")
          .values({
            call_id: callId,
            seq,
            role: turn.role,
            text: turn.text ?? null,
            tool_name: turn.toolName ?? null,
            tool_input: turn.toolInput === undefined ? null : JSON.stringify(turn.toolInput),
            tool_result: turn.toolResult === undefined ? null : JSON.stringify(turn.toolResult),
            state: turn.state,
            latency_ms: turn.latencyMs ?? null,
          })
          .execute();
      })
      .catch((err: unknown) =>
        this.logger.error({ err, callId, seq }, "failed to record call turn"),
      );
  }

  drain(): Promise<void> {
    return this.queue;
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}
