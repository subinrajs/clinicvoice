/**
 * Minimal forward-only migration runner: applies migrations/*.sql in filename order, each in
 * its own transaction, recording applied files in schema_migrations. Runs as the schema owner.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
// Arbitrary constant: serializes concurrent deploys running migrations at the same time.
const ADVISORY_LOCK_KEY = 7_204_311;

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
        (r) => r.filename,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed`, { cause: error });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error("DATABASE_MIGRATION_URL is not set");
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
