import { DIALECT_CONTRACT_VERSION, type DialectPlugin } from "@typed-sql/core";
import { parseSelect, SqlParseError } from "@typed-sql/ast";
import {
  parseSchemaSnapshot,
  type SchemaSnapshot,
} from "@typed-sql/schema";
import { resolveSelect } from "./resolver.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./type-policy.js";

export const POSTGRES_DIALECT_VERSION = "0.2.0";

export type PostgresSchemaSnapshot = SchemaSnapshot & { readonly dialect: "postgres" };
export interface PostgresDialectOptions {
  readonly typePolicy?: PostgresTypePolicy;
}

function validatePostgresSnapshot(value: unknown): PostgresSchemaSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "postgres") {
    throw new TypeError(`@typed-sql/postgres cannot use a ${snapshot.dialect} schema snapshot`);
  }
  return snapshot as PostgresSchemaSnapshot;
}

export function postgres(options: PostgresDialectOptions = {}): DialectPlugin<PostgresSchemaSnapshot, PostgresTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultPostgresTypePolicy;
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "postgres",
    packageVersion: POSTGRES_DIALECT_VERSION,
    defaultTypePolicy,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("PostgreSQL parameter indexes start at 1");
      return `$${index}`;
    },
    analyze(sql: string, snapshot: PostgresSchemaSnapshot, policy = defaultTypePolicy) {
      try {
        return resolveSelect(parseSelect(sql), snapshot, { typePolicy: policy });
      } catch (error) {
        if (!(error instanceof SqlParseError)) throw error;
        return {
          columns: [],
          diagnostics: [{ code: error.code, message: error.message, severity: "error" as const, range: error.range }],
        };
      }
    },
    validateSnapshot: validatePostgresSnapshot,
  });
}

export {
  parseSchemaSnapshot,
} from "@typed-sql/schema";
export { introspectPostgres, loadPostgresDriver, PostgresSchemaProvider, postgresCatalogQueries } from "./provider.js";
export { defaultPostgresTypePolicy, isKnownPostgresType, mapPostgresType } from "./type-policy.js";
export type { PostgresTypePolicy } from "./type-policy.js";
export type { SchemaSnapshot } from "@typed-sql/schema";
export type {
  PostgresDriverImporter,
  PostgresDriverModule,
  PostgresIntrospectionClient,
  PostgresIntrospectionPool,
  PostgresQueryable,
  PostgresQueryResult,
  PostgresSchemaProviderOptions,
} from "./provider.js";
