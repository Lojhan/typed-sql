import { createPostgresCoreAnalyzer, type PostgresCoreOptions } from "./analysis/core/factory.js";
import { coreDigests, nativeSignatures } from "./catalog/generated/offline.js";
import { postgresCoreCatalogForSchema } from "./catalog/index.js";

export type { PostgresAnalysisPack, PostgresCoreOptions } from "./analysis/core/factory.js";
/** Compact offline rules. Add an explicit pack or a qualified query contract for the long tail. */
export function postgres(options: PostgresCoreOptions = {}) {
  return createPostgresCoreAnalyzer(options, nativeSignatures, postgresCoreCatalogForSchema, coreDigests);
}
