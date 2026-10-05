import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  // Graceful shutdown: stop accepting work, let in-flight calls and DB writes settle, then exit.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      app.log.error("forced exit after shutdown timeout");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  // Logger may not exist yet (bad config); stderr is the only safe channel here.
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
