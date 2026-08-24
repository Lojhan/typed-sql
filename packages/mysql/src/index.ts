import { parseStatement, SqlParseError } from "@typed-sql/ast";
import { DIALECT_CONTRACT_VERSION, type DialectPlugin } from "@typed-sql/core";
import { parseSchemaSnapshot, type SchemaSnapshot } from "@typed-sql/schema";
import { resolveMySqlStatement } from "./resolver.js";
import { defaultMySqlTypePolicy, type MySqlTypePolicy } from "./type-policy.js";

export const MYSQL_DIALECT_VERSION = "1.0.0";
export type MySqlSchemaSnapshot = SchemaSnapshot & { readonly dialect: "mysql" };

export interface MySqlDialectOptions {
  readonly typePolicy?: MySqlTypePolicy;
}

function validateMySqlSnapshot(value: unknown): MySqlSchemaSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "mysql") throw new TypeError(`@typed-sql/mysql cannot use a ${snapshot.dialect} schema snapshot`);
  return snapshot as MySqlSchemaSnapshot;
}

export function mysql(options: MySqlDialectOptions = {}): DialectPlugin<MySqlSchemaSnapshot, MySqlTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultMySqlTypePolicy;
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "mysql",
    grammarVersion: MYSQL_DIALECT_VERSION,
    sqlModule: "@typed-sql/mysql",
    defaultTypePolicy,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("MySQL parameter indexes start at 1");
      return "?";
    },
    analyze(sql: string, snapshot: MySqlSchemaSnapshot, policy = defaultTypePolicy) {
      try {
        return resolveMySqlStatement(parseStatement(sql, { syntax: "mysql" }), snapshot, { typePolicy: policy });
      } catch (error) {
        if (!(error instanceof SqlParseError)) throw error;
        return { columns: [], diagnostics: [{ code: error.code, message: error.message, severity: "error" as const, range: error.range }] };
      }
    },
    validateSnapshot: validateMySqlSnapshot,
  });
}

export { parseSchemaSnapshot } from "@typed-sql/schema";
export { sql } from "@typed-sql/core";
export { MySqlSchemaProvider, introspectMySql, mysqlCatalogQueries } from "./provider.js";
export { defaultMySqlTypePolicy, defaultMySqlTypePolicy as typePolicy, isKnownMySqlType, mapMySqlType } from "./type-policy.js";
export type { MySqlTypePolicy } from "./type-policy.js";
export type { SchemaSnapshot } from "@typed-sql/schema";
export type { MySqlQueryable, MySqlSchemaProviderOptions } from "./provider.js";
