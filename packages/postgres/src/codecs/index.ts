import type { SchemaSnapshot } from "@typed-sql/schema";
import { POSTGRES_SUPPORT_POLICY, parsePostgresMajor } from "../support.js";
import { normalizePostgresDatabaseType } from "./normalize.js";
import type { PostgresCodecTypeMapping } from "./types.js";
import { postgresCodecTypes } from "./types-data.js";

/** Mirrors semantic catalog selection without importing casts, operators or routine families. */
export function postgresCodecTypeMapping(
  databaseType: string,
  schema?: SchemaSnapshot,
): PostgresCodecTypeMapping | undefined {
  const evidence = schema?.server?.versionKey ?? schema?.version;
  const major = evidence === undefined ? undefined : parsePostgresMajor(evidence);
  const types =
    (major === undefined ? undefined : postgresCodecTypes[major]) ??
    postgresCodecTypes[POSTGRES_SUPPORT_POLICY.stableMajors[0]]!;
  const normalized = normalizePostgresDatabaseType(databaseType);
  return Object.hasOwn(types, normalized) ? types[normalized] : undefined;
}
