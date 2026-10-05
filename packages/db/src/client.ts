import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

// Return DATE columns as "YYYY-MM-DD" strings rather than local-midnight Date objects, which
// silently shift a date of birth across time zones.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export interface DbOptions {
  connectionString: string;
  maxConnections?: number;
  /** Optional hook for statement logging; never log parameters (they contain PHI). */
  onQueryError?: (error: unknown) => void;
}

export type Db = Kysely<Database>;

export function createDb(options: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => {
      if (event.level === "error") options.onQueryError?.(event.error);
    },
  });
}
