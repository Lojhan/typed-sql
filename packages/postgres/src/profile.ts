import { DIALECT_CONTRACT_VERSION, type DialectPlugin } from "@typed-sql/core";
import { POSTGRES_CAPABILITIES, resolvePostgresCapabilities } from "./capabilities.js";
import { tokenize } from "./parser/tokenizer.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./policy.js";
import { type PostgresProfileSnapshot, validatePostgresSnapshot } from "./profile-snapshot.js";
import { postgresRenderer } from "./rendering.js";
import type { PostgresVersionPolicy } from "./support.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

export type { PostgresProfileSnapshot } from "./profile-snapshot.js";

export interface PostgresProfileOptions {
  readonly typePolicy?: PostgresTypePolicy;
  readonly versionPolicy?: PostgresVersionPolicy;
}
/** Rendering, vocabulary, snapshot and policy support without loading the SQL analyzer. */
export function postgresProfile(
  options: PostgresProfileOptions = {},
): Omit<DialectPlugin<PostgresProfileSnapshot, PostgresTypePolicy>, "analyze"> {
  const policy = Object.freeze({ ...(options.typePolicy ?? defaultPostgresTypePolicy) });
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "postgres",
    grammarVersion: POSTGRES_DIALECT_VERSION,
    sqlModule: "@typed-sql/postgres",
    runtimeSqlModule: "@typed-sql/postgres/tag",
    capabilities: POSTGRES_CAPABILITIES,
    defaultTypePolicy: policy,
    resolveCapabilities: (snapshot: PostgresProfileSnapshot) =>
      resolvePostgresCapabilities(snapshot, options.versionPolicy ?? "stable"),
    placeholder: postgresRenderer.placeholder,
    quoteIdentifier: postgresRenderer.quoteIdentifier,
    parameterOccurrences(sql: string) {
      return tokenize(sql, { sqlFileParameters: true })
        .filter((token) => token.kind === "parameter")
        .map((token) => ({
          index: token.text.startsWith(":") ? 0 : Number(token.value),
          ...(token.text.startsWith(":") ? { name: token.value } : {}),
          range: token.range,
        }));
    },
    validateSnapshot: validatePostgresSnapshot,
  });
}
export type { PostgresTypePolicy } from "./policy.js";
export { defaultPostgresTypePolicy as typePolicy } from "./policy.js";
