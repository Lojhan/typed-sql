import { sql } from "@typed-sql/mysql";
import type { MySqlDatabase } from "@typed-sql/mysql/runtime";

const wait = (seconds: number) => sql`SELECT SLEEP(${seconds})`;

export function waitUntilDeadline(database: MySqlDatabase, seconds: number, timeoutMilliseconds: number) {
  return database.all(wait(seconds), { deadline: Date.now() + timeoutMilliseconds });
}

export function waitUntilAborted(database: MySqlDatabase, seconds: number, signal: AbortSignal) {
  return database.all(wait(seconds), { signal });
}
