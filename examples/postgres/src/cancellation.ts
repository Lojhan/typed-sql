import { sql } from "@typed-sql/postgres";
import type { PostgresDatabase } from "@typed-sql/postgres/runtime";

const wait = (seconds: number) => sql`SELECT pg_sleep(${seconds})`;

export function waitUntilDeadline(database: PostgresDatabase, seconds: number, timeoutMilliseconds: number) {
  return database.all(wait(seconds), { deadline: Date.now() + timeoutMilliseconds });
}

export function waitUntilAborted(database: PostgresDatabase, seconds: number, signal: AbortSignal) {
  return database.all(wait(seconds), { signal });
}
