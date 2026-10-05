import type { Db } from "@clinicvoice/db";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";

export const healthRoutes =
  (db: Db): FastifyPluginAsync =>
  async (app) => {
    /** Liveness: the process is up. */
    app.get("/healthz", async () => ({ status: "ok" }));

    /** Readiness: dependencies reachable. Used by the host's health check before routing calls. */
    app.get("/readyz", async (_req, reply) => {
      try {
        await sql`select 1`.execute(db);
        return { status: "ready" };
      } catch (err) {
        app.log.error({ err }, "readiness check failed");
        return reply.code(503).send({ status: "unavailable" });
      }
    });
  };
