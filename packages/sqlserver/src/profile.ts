import { DIALECT_CONTRACT_VERSION, type DialectProfile } from "@typed-sql/core";
import { resolveSqlServerCapabilities, SQLSERVER_CAPABILITIES } from "./capabilities.js";
import { tokenize } from "./parser/tokenizer.js";
import { sqlServerRenderer } from "./query.js";
import { parseSqlServerSchemaSnapshot, type SqlServerSchemaSnapshot } from "./snapshot.js";
import {
  defaultSqlServerTypePolicy,
  type SqlServerTypePolicy,
  sqlServerRuntimeValueType,
  validateSqlServerTypePolicy,
} from "./type-policy.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";

export interface SqlServerProfileOptions {
  readonly typePolicy?: SqlServerTypePolicy;
}
export function sqlserverProfile(
  options: SqlServerProfileOptions = {},
): DialectProfile<SqlServerSchemaSnapshot, SqlServerTypePolicy> {
  const policy = validateSqlServerTypePolicy(options.typePolicy ?? defaultSqlServerTypePolicy);
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "sqlserver",
    grammarVersion: SQLSERVER_DIALECT_VERSION,
    sqlModule: "@typed-sql/sqlserver",
    runtimeSqlModule: "@typed-sql/sqlserver/query",
    capabilities: SQLSERVER_CAPABILITIES,
    resolveCapabilities: resolveSqlServerCapabilities,
    defaultTypePolicy: policy,
    runtimeValueType: sqlServerRuntimeValueType,
    placeholder: sqlServerRenderer.placeholder,
    quoteIdentifier: sqlServerRenderer.quoteIdentifier,
    parameterOccurrences(source: string) {
      return tokenize(source, { sqlFileParameters: true })
        .filter((token) => token.kind === "parameter")
        .map((token) => ({
          index: /^@__typed_sql_\d+$/u.test(token.text) || token.text === "?" ? Number(token.value) : 0,
          ...(/^@__typed_sql_\d+$/u.test(token.text) || token.text === "?" ? {} : { name: token.text.slice(1) }),
          range: token.range,
        }));
    },
    validateSnapshot: parseSqlServerSchemaSnapshot,
  });
}

export type { SqlServerSchemaSnapshot } from "./snapshot.js";
export type { SqlServerTypePolicy } from "./type-policy.js";
export { defaultSqlServerTypePolicy as typePolicy } from "./type-policy.js";
