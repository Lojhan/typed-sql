import type {
  ContractReconciliationContribution,
  NativeContractAdapter,
  QueryContractContext,
} from "@typed-sql/analysis";
import { queryContractDigest } from "@typed-sql/analysis";
import type { DialectPlugin, DialectProfile, SchemaSnapshot } from "@typed-sql/core";
import { postgres } from "@typed-sql/postgres/analysis/core/18";
import { createPgNativeContractAdapter, type PgNativeContractOptions } from "@typed-sql/postgres/pg-contracts";
import { type PostgresTypePolicy, postgresProfile } from "@typed-sql/postgres/profile";
import { createPostgresContractReconciler } from "@typed-sql/postgres/reconciliation";
import { calculateSchemaHash, parseSchemaSnapshot } from "@typed-sql/schema";

/** Test contribution built exclusively from published contracts and base-grammar entrypoints. */
export function inheritedPostgres(schema: SchemaSnapshot) {
  const grammar = Object.freeze({ id: "vendor/postgres-derived", version: "1.0.0-derived.1" });
  const baseProfile = postgresProfile();
  const baseAnalyzer = postgres();
  const baseSnapshot = (snapshot: SchemaSnapshot) =>
    baseAnalyzer.validateSnapshot({ ...snapshot, dialect: baseProfile.id, dialectVersion: baseProfile.grammarVersion });
  const validateSnapshot = (input: unknown): SchemaSnapshot => {
    const snapshot = parseSchemaSnapshot(input);
    if (snapshot.dialect !== grammar.id || snapshot.dialectVersion !== grammar.version)
      throw new TypeError("Derived grammar snapshot identity mismatch");
    baseSnapshot(snapshot);
    return snapshot;
  };
  const snapshot = validateSnapshot({ ...schema, dialect: grammar.id, dialectVersion: grammar.version });
  const profile = Object.freeze<DialectProfile<SchemaSnapshot, PostgresTypePolicy>>({
    ...baseProfile,
    id: grammar.id,
    grammarVersion: grammar.version,
    sqlModule: "@vendor/postgres-derived",
    runtimeSqlModule: "@vendor/postgres-derived/query",
    validateSnapshot,
    resolveCapabilities: (value, policy) => baseProfile.resolveCapabilities!(baseSnapshot(value), policy),
    parameterOccurrences: (sql, value, policy) => baseProfile.parameterOccurrences!(sql, baseSnapshot(value), policy),
  });
  const analyzer = Object.freeze<DialectPlugin<SchemaSnapshot, PostgresTypePolicy>>({
    ...profile,
    analyze: (sql, value, policy, context) =>
      baseAnalyzer.analyze(sql, baseSnapshot(validateSnapshot(value)), policy, context),
  });
  const baseContribution = createPostgresContractReconciler({ schema: baseSnapshot(snapshot) });
  const contribution: ContractReconciliationContribution = Object.freeze({
    ...baseContribution,
    id: "@vendor/postgres-derived/reconciliation",
    version: "1",
    grammar,
  });
  const mapContext = (context: QueryContractContext): QueryContractContext => ({
    ...context,
    grammar,
    schemaHash: calculateSchemaHash(snapshot),
    profileHash: queryContractDigest({ inherited: context.profileHash, grammar }),
    interpreterHash: queryContractDigest({
      inherited: context.interpreterHash,
      grammar,
      reconciliation: contribution.version,
    }),
  });
  return {
    snapshot,
    profile,
    analyzer,
    contribution,
    native(options: Omit<PgNativeContractOptions, "schema">) {
      const base = createPgNativeContractAdapter({ ...options, schema: baseSnapshot(snapshot) });
      const adapter: NativeContractAdapter & { inspectContext(signal?: AbortSignal): Promise<QueryContractContext> } = {
        id: base.id,
        version: base.version,
        grammar,
        accept: (candidate) => base.accept(candidate),
        classifyError: (error) => base.classifyError!(error),
        inspectContext: async (signal) => mapContext(await base.inspectContext(signal)),
        async open(signal) {
          const session = await base.open(signal);
          return {
            context: async (contextSignal) => mapContext(await session.context(contextSignal)),
            describe: (candidate, descriptionSignal) => session.describe(candidate, descriptionSignal),
            close: () => session.close(),
          };
        },
      };
      // Project-catalog permissions are not inherited implicitly by a new owner.
      return adapter;
    },
  };
}
