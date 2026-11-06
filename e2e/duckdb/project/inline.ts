import { sql } from "@typed-sql/duckdb";
export const inline = (id: bigint) => sql`SELECT id,amount,profile,coordinates,bytes FROM records WHERE id=${id}`;
export const repeated = (ids: readonly bigint[]) =>
  sql`SELECT id FROM records WHERE id IN (${ids.map((id) => sql.fragment`${id}`)}) ORDER BY id`;
export const conditional = (profile: boolean) =>
  sql`SELECT id${profile ? sql.fragment`,profile` : sql.empty} FROM records WHERE id=${4n}`;
