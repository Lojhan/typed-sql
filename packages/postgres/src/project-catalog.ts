import {
  createProjectCatalog,
  type ProjectCatalog,
  type ProjectCatalogContribution,
  type ProjectCatalogEntry,
  type QueryContractContext,
  queryContractDigest,
} from "@typed-sql/analysis";
import {
  calculateSchemaHash,
  calculateTypePolicyHash,
  parseSchemaSnapshot,
  type RoutineSnapshot,
  type SchemaSnapshotV2,
} from "@typed-sql/schema";
import type { PostgresSchemaSnapshot } from "./analysis-options.js";
import { parseStatement, walkStatement } from "./parser/index.js";
import { validatePostgresSnapshot } from "./profile-snapshot.js";
import {
  postgresProjectCatalogOwner,
  postgresProjectCatalogPermissionKey,
  postgresProjectRoutineIsFixed,
} from "./project-catalog-policy.js";
import { defaultPostgresTypePolicy, mapPostgresType, type PostgresTypePolicy } from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

/** Select complete overload families from introspected metadata, without preparing or executing SQL. */
export function createPostgresProjectCatalog(input: {
  readonly source: SchemaSnapshotV2;
  readonly context: QueryContractContext;
  readonly sql: readonly string[];
  readonly typePolicy?: PostgresTypePolicy;
}): ProjectCatalog {
  const source = validatePostgresSnapshot(input.source),
    policy = input.typePolicy ?? defaultPostgresTypePolicy;
  if (
    source.formatVersion !== 2 ||
    source.dialect !== "postgres" ||
    source.dialectVersion !== POSTGRES_DIALECT_VERSION ||
    input.context.grammar.id !== "postgres" ||
    input.context.grammar.version !== POSTGRES_DIALECT_VERSION
  )
    throw new TypeError("PostgreSQL project catalog source grammar differs");
  if (calculateTypePolicyHash(policy) !== input.context.typePolicyHash)
    throw new TypeError("PostgreSQL project catalog decoding policy differs");
  if (input.sql.length > 4096 || input.sql.reduce((size, sql) => size + Buffer.byteLength(sql), 0) > 16 * 1024 * 1024)
    throw new RangeError("PostgreSQL project query limit exceeded");
  const calls = new Map<string, Set<string | undefined>>();
  for (const sql of input.sql)
    walkStatement(parseStatement(sql), {
      expression(expression) {
        if (expression.kind !== "call") return;
        const name = expression.name.quoted ? expression.name.name : expression.name.name.toLowerCase();
        const namespace =
          expression.schema === undefined
            ? undefined
            : expression.schema.quoted
              ? expression.schema.name
              : expression.schema.name.toLowerCase();
        const namespaces = calls.get(name) ?? new Set<string | undefined>();
        namespaces.add(namespace);
        calls.set(name, namespaces);
      },
    });
  const entries: ProjectCatalogEntry[] = [];
  const sourceSchemaHash = calculateSchemaHash(source);
  for (const overloads of Object.values(source.routines)) {
    if (!overloads.length) continue;
    const selected = overloads.filter((routine) => {
      const namespaces = calls.get(routine.name);
      return namespaces?.has(undefined) || namespaces?.has(routine.schema);
    });
    if (!selected.length) continue;
    // Keep every sibling. Partial family extraction could change overload selection.
    const fixed = overloads.every((routine) => postgresProjectRoutineIsFixed(routine, source, policy));
    for (const routine of overloads)
      entries.push({
        kind: "routine",
        identity: routine.identity,
        permission: fixed ? "fixed-result" : "query-only",
        evidenceDigest: queryContractDigest({ sourceSchemaHash, routine }),
        definition: { routine, server: source.server },
      });
  }
  return createProjectCatalog({ context: input.context, owner: postgresProjectCatalogOwner, entries });
}
/** Installed grammar code rechecks permissions; a JSON artifact cannot register its own interpreter. */
export function createPostgresProjectCatalogContribution(): ProjectCatalogContribution<
  PostgresSchemaSnapshot,
  PostgresTypePolicy
> {
  return Object.freeze({
    ...postgresProjectCatalogOwner,
    grammar: { id: "postgres", version: POSTGRES_DIALECT_VERSION },
    apply(schema: PostgresSchemaSnapshot, entries: readonly ProjectCatalogEntry[], policy: PostgresTypePolicy) {
      if (schema.formatVersion !== 2) throw new TypeError("PostgreSQL project catalogs require schema format 2");
      const routines: Record<string, RoutineSnapshot[]> = Object.fromEntries(
        Object.entries(schema.routines).map(([key, values]) => [key, [...values]]),
      );
      const existing = new Set(
        Object.values(routines)
          .flat()
          .map((routine) => routine.identity),
      );
      for (const entry of entries) {
        if (
          entry.kind !== "routine" ||
          Object.keys(entry.definition).sort().join(",") !== "routine,server" ||
          !["fixed-result", "query-only", "declaration-only"].includes(entry.permission)
        )
          throw new TypeError("Unsupported PostgreSQL project catalog declaration");
        if (queryContractDigest(entry.definition.server) !== queryContractDigest(schema.server))
          throw new TypeError("PostgreSQL project source server evidence differs");
        const parsed = parseSchemaSnapshot({ ...schema, routines: { selected: [entry.definition.routine] } });
        if (parsed.formatVersion !== 2) throw new TypeError("Invalid PostgreSQL routine declaration");
        const routine = parsed.routines.selected![0]!;
        if (routine.identity !== entry.identity || existing.has(routine.identity))
          throw new TypeError("Conflicting PostgreSQL project routine identity");
        if (entry.permission === "fixed-result" && !postgresProjectRoutineIsFixed(routine, schema, policy))
          throw new TypeError("PostgreSQL project routine does not establish a fixed result");
        existing.add(routine.identity);
        const result = routine.result;
        const normalized: RoutineSnapshot = {
          ...routine,
          arguments: routine.arguments.map((argument) => ({
            ...argument,
            tsType: mapPostgresType(argument.databaseType, policy, schema),
          })),
          result:
            result.kind === "scalar" || result.kind === "set"
              ? {
                  ...result,
                  nullable: true,
                  tsType:
                    entry.permission === "fixed-result"
                      ? mapPostgresType(result.databaseType, policy, schema)
                      : "unknown",
                }
              : result,
          extension: {
            version: routine.extension?.version ?? "1",
            attributes: { ...routine.extension?.attributes, [postgresProjectCatalogPermissionKey]: entry.permission },
          },
        };
        const key = JSON.stringify([routine.schema ?? null, routine.name]);
        const family = routines[key] ?? [];
        family.push(normalized);
        routines[key] = family;
      }
      const parsed = parseSchemaSnapshot({ ...schema, routines });
      if (parsed.dialect !== "postgres") throw new TypeError("PostgreSQL project catalog changed grammar");
      return parsed as PostgresSchemaSnapshot;
    },
  });
}
