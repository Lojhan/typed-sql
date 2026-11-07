import { emptyHistory, parseHistory } from "@typed-sql/migrations";
import type { Pool } from "pg";
import type { PlaygroundCatalogObject, PlaygroundMigrationObservation } from "./explorer-types.js";

export function historyNamespace(value: string | undefined): string {
  const name = value ?? "typed_sql";
  if (!name || name.includes("\0") || Buffer.byteLength(name) > 63)
    throw new TypeError("The PostgreSQL history namespace must contain 1–63 UTF-8 bytes and no NUL bytes");
  return name;
}
/** PostgreSQL keys are adapter-owned, including identifier arrays containing dots or quotes. */
export function postgresCatalogObjects(keys: readonly string[]): readonly PlaygroundCatalogObject[] {
  const objects: PlaygroundCatalogObject[] = [];
  for (const key of keys) {
    const separator = key.indexOf(":");
    if (separator < 1) continue;
    const kind = key.slice(0, separator);
    let names: unknown;
    try {
      names = JSON.parse(key.slice(separator + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(names) || !names.length || names.some((name) => typeof name !== "string" || !name)) continue;
    const [namespace, relation, member] = names as string[];
    if (kind === "namespace" && names.length === 1)
      objects.push({ key, kind, namespace: namespace!, name: namespace! });
    else if (["relation", "type", "sequence"].includes(kind) && names.length === 2)
      objects.push({ key, kind, namespace: namespace!, name: relation! });
    else if (
      ["column", "index", "constraint", "trigger", "policy", "rewrite", "foreign-table"].includes(kind) &&
      names.length === 3
    )
      objects.push({ key, kind, namespace: namespace!, parentName: relation!, name: member! });
    else if (kind === "routine" && names.length === 3)
      objects.push({ key, kind, namespace: namespace!, name: `${relation}(${member})` });
  }
  return objects;
}

/** One pinned read-only observation. It never creates or locks a ledger or executes migrations. */
export async function observePostgresMigrations(
  pool: Pool,
  namespace: string,
): Promise<PlaygroundMigrationObservation> {
  const client = await pool.connect();
  let healthy = true;
  const observe = async (): Promise<PlaygroundMigrationObservation> => {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '10000ms'");
    const identity = await client.query<{ database: string }>("select pg_catalog.current_database() as database");
    const database = identity.rows[0]?.database;
    if (!database) throw new TypeError("The PostgreSQL target did not return a database identity");
    const ledger = `"${namespace.replaceAll('"', '""')}"."migration_history"`;
    const present = await client.query<{ present: string | null }>("select pg_catalog.to_regclass($1) as present", [
      ledger,
    ]);
    if (present.rows[0]?.present == null)
      return { state: "missing", database, historyNamespace: namespace, history: emptyHistory(), objects: [] };
    const result = await client.query<{ bytes: number; document: unknown }>(
      `select pg_catalog.octet_length(document::text) as bytes,
      case when pg_catalog.octet_length(document::text) <= $1 then document else null end as document
      from ${ledger} where singleton = true limit 2`,
      [8 * 1024 * 1024],
    );
    if (result.rows.length !== 1 || result.rows[0]!.bytes > 8 * 1024 * 1024)
      throw new TypeError("Migration history is invalid or exceeds the 8 MiB observation limit");
    const history = parseHistory(result.rows[0]!.document);
    if (history.attempts.length > 5000 || history.applied.length > 2000)
      throw new TypeError("Migration history exceeds the observation entry limit");
    const keys = new Set<string>();
    for (const catalog of [
      ...history.applied.map((item) => item.catalog),
      ...history.attempts.flatMap((item) => [item.beforeCatalog, item.expectedCatalog]),
    ]) {
      for (const key of Object.keys(catalog?.objects ?? {})) {
        keys.add(key);
        if (keys.size > 25_000) throw new TypeError("Migration object history exceeds the observation limit");
      }
    }
    return {
      state: "ready",
      database,
      historyNamespace: namespace,
      history,
      objects: postgresCatalogObjects([...keys]),
    };
  };
  let observation: PlaygroundMigrationObservation | undefined;
  let failure: unknown;
  try {
    observation = await observe();
  } catch (error) {
    failure = error;
  }
  try {
    await client.query("rollback");
  } catch (error) {
    healthy = false;
    failure ??= error;
  }
  client.release(!healthy);
  if (failure !== undefined) throw failure;
  return observation!;
}
