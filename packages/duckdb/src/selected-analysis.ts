import { createDuckDBAnalyzer } from "./analysis-factory.js";
import { loadDuckDBCatalog } from "./catalog/generated/profile-loader.js";
import type { DuckDBProfileOptions as DuckDBDialectOptions } from "./profile.js";

export type { DuckDBProfileOptions as DuckDBDialectOptions } from "./profile.js";
export async function loadDuckDBAnalyzer(options: DuckDBDialectOptions & { readonly version: string }) {
  const { version, ...policy } = options;
  const catalog = await loadDuckDBCatalog(version);
  return createDuckDBAnalyzer(policy, () => catalog, version);
}
