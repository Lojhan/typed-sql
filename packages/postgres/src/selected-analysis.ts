import { createPostgresAnalyzer } from "./analysis-factory.js";
import type { PostgresDialectOptions } from "./analysis-options.js";
import { loadPostgresCoreCatalog } from "./catalog/generated/core-loader.js";
import { loadPostgresNativeSignatures } from "./catalog/generated/native-loader.js";

export type { PostgresDialectOptions } from "./analysis-options.js";
/** Load one retained native-signature profile. Snapshot evidence must match the requested major. */
export async function loadPostgresAnalyzer(options: PostgresDialectOptions & { readonly major: number }) {
  const { major, ...policy } = options;
  const [signatures, catalog] = await Promise.all([
    loadPostgresNativeSignatures(major),
    loadPostgresCoreCatalog(major),
  ]);
  return createPostgresAnalyzer(policy, Object.freeze({ [major]: signatures }), () => catalog, major);
}
