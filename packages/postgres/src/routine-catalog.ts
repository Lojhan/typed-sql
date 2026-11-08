import type { RoutineArgumentMode, RoutineSnapshot, SchemaSnapshot } from "@typed-sql/schema";
import { mapPostgresType, type PostgresTypePolicy } from "./type-policy.js";

export interface PostgresRoutineCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly function_name: string;
  readonly argument_types: string[];
  readonly argument_type_identities?: readonly string[];
  readonly return_type_identity?: string;
  readonly database_return_type: string;
  readonly set_returning: boolean;
  readonly volatility: "i" | "s" | "v";
  readonly routine_identity?: string;
  readonly routine_kind?: "f" | "p" | "a" | "w";
  readonly argument_names?: readonly (string | null)[];
  readonly argument_modes?: readonly ("i" | "o" | "b" | "v" | "t")[];
  readonly argument_defaults?: number;
  readonly strict?: boolean;
  readonly parallel_safety?: "r" | "s" | "u";
}

function argumentMode(mode: "i" | "o" | "b" | "v" | "t" | undefined): RoutineArgumentMode {
  if (mode === "o" || mode === "t") return "out";
  if (mode === "b") return "inout";
  if (mode === "v") return "variadic";
  return "in";
}

function routineKind(kind: PostgresRoutineCatalogRow["routine_kind"]): RoutineSnapshot["kind"] {
  if (kind === "p") return "procedure";
  if (kind === "a") return "aggregate";
  if (kind === "w") return "window";
  return "function";
}

function parallelSafety(safety: PostgresRoutineCatalogRow["parallel_safety"]): string {
  if (safety === "r") return "restricted";
  if (safety === "s") return "safe";
  if (safety === "u") return "unsafe";
  return "unknown";
}

function polymorphicFamily(types: readonly string[]): string | undefined {
  if (types.some((type) => /^anycompatible/u.test(type))) return "postgres-anycompatible";
  if (types.some((type) => /^any/u.test(type))) return "postgres-anyelement";
  return undefined;
}

/** Reads only routine/type namespace metadata; selected capture rejects a truncated family. */
export function postgresRoutineCatalogQuery(selected = false): string {
  return `
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      'pg:' || p.oid::pg_catalog.text AS routine_identity,
      p.prokind AS routine_kind,
      ARRAY(
        SELECT pg_catalog.format_type(argument_oid, NULL)
        FROM pg_catalog.unnest(COALESCE(p.proallargtypes, p.proargtypes::pg_catalog.oid[])) WITH ORDINALITY AS arguments(argument_oid, position)
        ORDER BY position
      ) AS argument_types,
      ARRAY(
        SELECT pg_catalog.format('%I.%I', type_namespace.nspname, argument_type.typname)
        FROM pg_catalog.unnest(COALESCE(p.proallargtypes, p.proargtypes::pg_catalog.oid[])) WITH ORDINALITY AS arguments(argument_oid, position)
        JOIN pg_catalog.pg_type AS argument_type ON argument_type.oid = argument_oid
        JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = argument_type.typnamespace
        ORDER BY position
      ) AS argument_type_identities,
      (SELECT pg_catalog.format('%I.%I', type_namespace.nspname, result_type.typname)
        FROM pg_catalog.pg_type AS result_type
        JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = result_type.typnamespace
        WHERE result_type.oid = p.prorettype) AS return_type_identity,
      COALESCE(p.proargnames, ARRAY[]::pg_catalog.text[]) AS argument_names,
      ARRAY(
        SELECT mode::pg_catalog.text
        FROM pg_catalog.unnest(COALESCE(p.proargmodes, ARRAY[]::pg_catalog."char"[])) WITH ORDINALITY AS modes(mode, position)
        ORDER BY position
      ) AS argument_modes,
      p.pronargdefaults AS argument_defaults,
      pg_catalog.format_type(p.prorettype, NULL) AS database_return_type,
      p.proretset AS set_returning,
      p.provolatile AS volatility,
      p.proisstrict AS strict,
      p.proparallel AS parallel_safety
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p', 'a', 'w')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::pg_catalog.text[] IS NULL OR n.nspname::pg_catalog.text OPERATOR(pg_catalog.=) ANY($1::pg_catalog.text[]))
    ${selected ? "AND EXISTS (SELECT 1 FROM ROWS FROM (pg_catalog.unnest($2::pg_catalog.text[]), pg_catalog.unnest($3::pg_catalog.text[])) AS selected(namespace, name) WHERE selected.namespace OPERATOR(pg_catalog.=) n.nspname::pg_catalog.text AND selected.name OPERATOR(pg_catalog.=) p.proname::pg_catalog.text)" : ""}
    ORDER BY n.nspname, p.proname, p.oid
    ${selected ? "LIMIT 4097" : ""}
  `;
}
export function postgresRoutineSnapshot(
  row: PostgresRoutineCatalogRow,
  policy: PostgresTypePolicy,
  schemaForFunctions: SchemaSnapshot,
): RoutineSnapshot {
  const name = row.schema_name === "public" ? row.function_name : `${row.schema_name}.${row.function_name}`;
  const modes = row.argument_modes ?? [];
  const inputPositions = row.argument_types
    .map((_, index) => index)
    .filter((index) => argumentMode(modes[index]) !== "out");
  const defaultStart = inputPositions.length - (row.argument_defaults ?? 0);
  const argumentsList = row.argument_types.map((databaseType, index) => ({
    ...(row.argument_names?.[index] == null ? {} : { name: row.argument_names[index]! }),
    mode: argumentMode(modes[index]),
    typeIdentity: row.argument_type_identities?.[index] ?? databaseType,
    databaseType,
    tsType: mapPostgresType(databaseType, policy, schemaForFunctions),
    default:
      inputPositions.indexOf(index) >= defaultStart && defaultStart >= 0 ? ("present" as const) : ("none" as const),
  }));
  const outputArguments = argumentsList.filter(({ mode }) => mode === "out" || mode === "inout");
  const kind = routineKind(row.routine_kind);
  const result =
    kind === "procedure"
      ? ({ kind: "command" } as const)
      : outputArguments.length > 0
        ? ({
            kind: "table" as const,
            columns: Object.fromEntries(
              outputArguments.map((argument, position) => [
                argument.name ?? `column${position + 1}`,
                {
                  name: argument.name ?? `column${position + 1}`,
                  position,
                  databaseType: argument.databaseType,
                  typeIdentity: argument.typeIdentity,
                  tsType: argument.tsType,
                  nullable: true,
                  nullabilitySource: "unknown" as const,
                  default: "none" as const,
                  generated: "none" as const,
                  identity: "none" as const,
                  classification: "normal" as const,
                  insertable: false,
                  updatable: false,
                },
              ]),
            ),
          } as const)
        : row.database_return_type === "record"
          ? ({ kind: "record", columns: {} } as const)
          : ({
              kind: row.set_returning ? "set" : "scalar",
              typeIdentity: row.return_type_identity ?? row.database_return_type,
              databaseType: row.database_return_type,
              tsType: mapPostgresType(row.database_return_type, policy, schemaForFunctions),
              nullable: true,
            } as const);
  const family = polymorphicFamily([...row.argument_types, row.database_return_type]);
  const routine: RoutineSnapshot = {
    name: row.function_name,
    schema: row.schema_name,
    identity: row.routine_identity ?? `${name}(${row.argument_types.join(",")})`,
    kind,
    arguments: argumentsList,
    result,
    volatility: row.volatility === "i" ? "immutable" : row.volatility === "s" ? "stable" : "volatile",
    deterministic: row.volatility === "i" ? true : "unknown",
    dataAccess: "unknown",
    nullInput: row.strict === undefined ? "unknown" : row.strict ? "strict" : "called",
    ...(family === undefined ? {} : { polymorphicFamily: family }),
    extension: {
      version: "1",
      attributes: { parallelSafety: parallelSafety(row.parallel_safety) },
    },
  };
  return routine;
}
