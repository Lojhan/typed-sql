import { DIALECT_CONTRACT_VERSION, type DialectProfile } from "@typed-sql/core";
import { parseSchemaSnapshot, type SchemaSnapshot } from "@typed-sql/schema";
import { assertMySqlServerEvidence, MYSQL_CAPABILITIES, resolveMySqlCapabilities } from "./capabilities.js";
import { tokenize } from "./parser/tokenizer.js";
import { mysqlRuntimeValueType } from "./query.js";
import { defaultMySqlTypePolicy, type MySqlTypePolicy } from "./type-policy.js";
import { MYSQL_DIALECT_VERSION } from "./version.js";
export type MySqlSchemaSnapshot = SchemaSnapshot & { readonly dialect: "mysql" };

export interface MySqlProfileOptions {
  readonly typePolicy?: MySqlTypePolicy;
  readonly versionPolicy?: import("./support.js").MySqlVersionPolicy;
}

function validateMySqlSnapshot(value: unknown): MySqlSchemaSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "mysql")
    throw new TypeError(`@typed-sql/mysql cannot use a ${snapshot.dialect} schema snapshot`);
  if (snapshot.dialectVersion !== undefined && snapshot.dialectVersion !== MYSQL_DIALECT_VERSION) {
    throw new TypeError(
      `@typed-sql/mysql grammar ${MYSQL_DIALECT_VERSION} cannot use snapshot dialectVersion ${snapshot.dialectVersion}`,
    );
  }
  if (snapshot.server !== undefined && snapshot.server.product !== "mysql") {
    throw new TypeError(`@typed-sql/mysql cannot use ${snapshot.server.product} server evidence`);
  }
  if (snapshot.server !== undefined) assertMySqlServerEvidence(snapshot.server);
  return snapshot as MySqlSchemaSnapshot;
}

export function mysqlProfile(options: MySqlProfileOptions = {}): DialectProfile<MySqlSchemaSnapshot, MySqlTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultMySqlTypePolicy;
  const versionPolicy = options.versionPolicy ?? "stable";
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "mysql",
    grammarVersion: MYSQL_DIALECT_VERSION,
    sqlModule: "@typed-sql/mysql",
    runtimeSqlModule: "@typed-sql/mysql/query",
    capabilities: MYSQL_CAPABILITIES,
    resolveCapabilities: (snapshot: MySqlSchemaSnapshot) => resolveMySqlCapabilities(snapshot, versionPolicy),
    defaultTypePolicy,
    runtimeValueType: mysqlRuntimeValueType,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("MySQL parameter indexes start at 1");
      return "?";
    },
    quoteIdentifier(identifier: string): string {
      return `\`${identifier.replaceAll("`", "``")}\``;
    },
    parameterOccurrences(sql: string, snapshot: MySqlSchemaSnapshot) {
      const sqlMode = snapshot.server?.settings.sqlMode;
      return tokenize(sql, { ...(typeof sqlMode === "string" ? { sqlMode } : {}), sqlFileParameters: true })
        .filter((token) => token.kind === "parameter")
        .map((token) => ({
          index: token.text.startsWith(":") ? 0 : Number(token.value),
          ...(token.text.startsWith(":") ? { name: token.value } : {}),
          range: token.range,
        }));
    },
    validateSnapshot: validateMySqlSnapshot,
  });
}

export type { MySqlTypePolicy } from "./type-policy.js";
export { defaultMySqlTypePolicy as typePolicy } from "./type-policy.js";
