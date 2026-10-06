import type { Db } from "@clinicvoice/db";
import { sql } from "kysely";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";

/** Job types and their payload schemas. Payloads carry ids only, never PHI. */
export const JobPayloads = {
  call_summary: z.object({ callId: z.uuid() }),
  implant_extraction: z.object({ screeningId: z.uuid(), questionId: z.string() }),
} as const;

export type JobType = keyof typeof JobPayloads;
export type JobPayload<T extends JobType> = z.infer<(typeof JobPayloads)[T]>;

export interface JobQueue {
  enqueue<T extends JobType>(
    type: T,
    payload: JobPayload<T>,
    options?: { dedupeKey?: string; delayMs?: number },
  ): Promise<void>;
}

export type JobHandler<T extends JobType> = (payload: JobPayload<T>) => Promise<void>;
export type JobHandlers = { [T in JobType]: JobHandler<T> };

export class PostgresJobQueue implements JobQueue {
  constructor(private readonly db: Db) {}

  async enqueue<T extends JobType>(
    type: T,
    payload: JobPayload<T>,
    options: { dedupeKey?: string; delayMs?: number } = {},
  ) {
    await this.db
      .insertInto("jobs")
      .values({
        type,
        payload: JSON.stringify(JobPayloads[type].parse(payload)),
        dedupe_key: options.dedupeKey ?? null,
        run_after: new Date(Date.now() + (options.delayMs ?? 0)),
      })
      .onConflict((oc) => oc.column("dedupe_key").doNothing())
      .execute();
  }
}

const BACKOFF_MS = [5_000, 30_000, 120_000];
/** A job stuck in "running" this long is assumed orphaned by a crashed worker and retried. */
const STALE_RUNNING_MS = 10 * 60_000;

/**
 * Polls for due jobs and runs them with retries and backoff. Claims use FOR UPDATE SKIP LOCKED,
 * so several server instances can run workers without double-processing.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly handlers: JobHandlers,
    private readonly logger: Logger,
    private readonly pollMs = 2_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.inFlight = this.drain()
        .then(() => undefined)
        .catch((err: unknown) => this.logger.error({ err }, "job worker poll failed"))
        .finally(() => {
          this.running = false;
        });
    }, this.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** Runs every due job once. Exposed for tests and the text harness. */
  async drain(maxJobs = 20): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      const job = await this.claim();
      if (!job) break;
      processed++;
      await this.run(job);
    }
    return processed;
  }

  private async claim() {
    const result = await sql<{
      id: string;
      type: string;
      payload: unknown;
      attempts: number;
      max_attempts: number;
    }>`
      UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM jobs
        WHERE (status = 'queued' AND run_after <= now())
           OR (status = 'running' AND updated_at < now() - make_interval(secs => ${STALE_RUNNING_MS / 1000}))
        ORDER BY run_after
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, type, payload, attempts, max_attempts
    `.execute(this.db);
    return result.rows[0];
  }

  private async run(job: {
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  }) {
    const log = this.logger.child({ jobId: job.id, jobType: job.type });
    try {
      const type = job.type as JobType;
      const schema = JobPayloads[type];
      if (!schema) throw new Error(`Unknown job type ${job.type}`);
      const handler = this.handlers[type] as JobHandler<typeof type>;
      await handler(schema.parse(job.payload) as never);
      await this.db
        .updateTable("jobs")
        .set({ status: "done", updated_at: new Date(), last_error: null })
        .where("id", "=", job.id)
        .execute();
    } catch (err) {
      const exhausted = job.attempts >= job.max_attempts;
      log.error({ err, attempt: job.attempts, exhausted }, "job failed");
      await this.db
        .updateTable("jobs")
        .set({
          status: exhausted ? "failed" : "queued",
          run_after: new Date(Date.now() + (BACKOFF_MS[job.attempts - 1] ?? 300_000)),
          last_error: err instanceof Error ? err.message.slice(0, 500) : "unknown error",
          updated_at: new Date(),
        })
        .where("id", "=", job.id)
        .execute();
    }
  }
}
