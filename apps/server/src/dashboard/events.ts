import { EventEmitter } from "node:events";
import pg from "pg";
import type { Logger } from "../lib/logger.js";

export interface DashboardEvent {
  table: string;
  id: string;
  op: string;
}

/**
 * One dedicated LISTEN connection fanned out to every open dashboard stream. Payloads carry
 * table and id only; clients refetch through the authenticated API. Reconnects with backoff.
 */
export class DashboardEvents {
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private stopped = false;
  private retryMs = 1_000;

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
  ) {
    this.emitter.setMaxListeners(200);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  subscribe(listener: (event: DashboardEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => {});
    this.client = null;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", (message) => {
      if (!message.payload) return;
      try {
        this.emitter.emit("event", JSON.parse(message.payload) as DashboardEvent);
      } catch {
        this.logger.warn("ignored malformed dashboard notification");
      }
    });
    client.on("error", (err) => {
      this.logger.error({ err }, "dashboard LISTEN connection error");
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query("LISTEN dashboard_events");
      this.client = client;
      this.retryMs = 1_000;
    } catch (err) {
      this.logger.error({ err }, "dashboard LISTEN connect failed");
      await client.end().catch(() => {});
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.client = null;
    setTimeout(() => void this.connect(), delay).unref();
  }
}
