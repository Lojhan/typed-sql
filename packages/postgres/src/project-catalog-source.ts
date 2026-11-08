import { parseSchemaSnapshot, type SchemaSnapshotV2 } from "@typed-sql/schema";
import { postgresProjectRoutineReferences } from "./project-catalog-selection.js";
import type { PostgresQueryable } from "./provider-contracts.js";
import {
  type PostgresRoutineCatalogRow,
  postgresRoutineCatalogQuery,
  postgresRoutineSnapshot,
} from "./routine-catalog.js";
import type { PostgresTypePolicy } from "./type-policy.js";

/** Metadata-only catalog reads on the caller's exclusively owned, guarded connection. */
export async function collectPostgresProjectRoutines(input: {
  readonly client: PostgresQueryable;
  readonly schema: SchemaSnapshotV2;
  readonly sql: readonly string[];
  readonly typePolicy: PostgresTypePolicy;
  readonly signal?: AbortSignal;
}): Promise<SchemaSnapshotV2> {
  input.signal?.throwIfAborted();
  const references = postgresProjectRoutineReferences(input.sql);
  const namespaces = new Set<string>();
  let searchPath = false;
  let observedSchemas: readonly string[] = [];
  for (const selected of references.values())
    for (const namespace of selected) {
      if (namespace === undefined) searchPath = true;
      else namespaces.add(namespace);
    }
  if (searchPath) {
    const row = (await input.client.query<{ schemas: string[] }>("SELECT pg_catalog.current_schemas(true) AS schemas"))
      .rows[0];
    if (
      !row ||
      !Array.isArray(row.schemas) ||
      row.schemas.length > 256 ||
      row.schemas.some((value) => typeof value !== "string")
    )
      throw new TypeError("Missing project catalog namespace evidence");
    observedSchemas = row.schemas;
    for (const namespace of row.schemas) namespaces.add(namespace);
    input.signal?.throwIfAborted();
  }
  const selected: { namespace: string; name: string }[] = [];
  for (const [name, explicit] of references) {
    const resolved = new Set(
      [...explicit].flatMap((namespace) => (namespace === undefined ? [...observedSchemas] : [namespace])),
    );
    for (const namespace of [...resolved].sort()) {
      if (selected.length >= 16_384) throw new RangeError("PostgreSQL project namespace selection limit exceeded");
      selected.push({ namespace, name });
    }
  }
  const rows = references.size
    ? (
        await input.client.query<PostgresRoutineCatalogRow>(postgresRoutineCatalogQuery(true), [
          [...namespaces].sort(),
          selected.map((pair) => pair.namespace),
          selected.map((pair) => pair.name),
        ])
      ).rows
    : [];
  input.signal?.throwIfAborted();
  if (rows.length > 4096) throw new RangeError("Project routine capture exceeded its complete-family limit");
  const routines: Record<string, ReturnType<typeof postgresRoutineSnapshot>[]> = {};
  for (const row of rows) {
    const routine = postgresRoutineSnapshot(row, input.typePolicy, input.schema);
    const key = JSON.stringify([routine.schema, routine.name]);
    const family = routines[key] ?? [];
    family.push(routine);
    routines[key] = family;
  }
  const source = parseSchemaSnapshot({ ...input.schema, routines });
  if (source.formatVersion !== 2) throw new TypeError("Invalid project catalog schema format");
  return source;
}
