import { createPostgresAnalyzer } from "../../analysis-factory.js";
import type { PostgresDialectOptions, PostgresSchemaSnapshot } from "../../analysis-options.js";
import type { PostgresNativeCatalog, PostgresNativeSignature } from "../../catalog/native-resolution.js";
import type { PostgresCoreCatalog } from "../../catalog/types.js";
import { POSTGRES_DIALECT_VERSION } from "../../version.js";
import { definePostgresAnalysisPack, type PostgresAnalysisPack } from "../packs/pack.js";

export type { PostgresAnalysisPack } from "../packs/pack.js";
export interface PostgresCoreOptions extends PostgresDialectOptions {
  readonly packs?: readonly PostgresAnalysisPack[];
}
export function createPostgresCoreAnalyzer(
  options: PostgresCoreOptions,
  core: PostgresNativeCatalog,
  catalogFor: (snapshot: PostgresSchemaSnapshot) => PostgresCoreCatalog,
  coreDigests: Readonly<Record<number, string>>,
  requiredMajor?: number,
) {
  const { packs = [], ...policy } = options;
  const selected = packs.map((pack) => definePostgresAnalysisPack(pack));
  for (const pack of selected) {
    const catalog = catalogFor({ formatVersion: 1, dialect: "postgres", version: String(pack.major), tables: {} });
    if (
      pack.grammarVersion !== POSTGRES_DIALECT_VERSION ||
      core[pack.major] === undefined ||
      catalog.major !== pack.major ||
      pack.catalogRevision !== catalog.revision ||
      pack.dependencies[0]?.digest !== coreDigests[pack.major] ||
      (requiredMajor !== undefined && requiredMajor !== pack.major)
    )
      throw new TypeError("PostgreSQL offline pack does not match the analyzer profile and grammar revision");
  }
  if (selected.length === 0) return createPostgresAnalyzer(policy, core, catalogFor, requiredMajor);
  const combined: Record<number, readonly PostgresNativeSignature[]> = {};
  for (const [version, base] of Object.entries(core)) {
    const signatures = new Map<string, PostgresNativeSignature>();
    for (const signature of [
      ...selected.filter((pack) => String(pack.major) === version).flatMap((pack) => pack.signatures),
      ...base,
    ]) {
      const previous = signatures.get(signature.identity);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(signature))
        throw new TypeError(`Conflicting PostgreSQL offline signature evidence: ${signature.identity}`);
      signatures.set(signature.identity, signature);
    }
    combined[Number(version)] = Object.freeze([...signatures.values()]);
  }
  return createPostgresAnalyzer(policy, Object.freeze(combined), catalogFor, requiredMajor);
}
