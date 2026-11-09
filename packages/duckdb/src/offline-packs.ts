import { createDuckDBDialect, type DuckDBDialectOptions } from "./analysis-factory.js";
import { createDuckDBCatalog, type DuckDBCatalogProvider, extendDuckDBCatalog } from "./catalog/provider.js";
import type { DuckDBBuiltinSignature } from "./catalog/types.js";
import type { DuckDBVocabulary } from "./vocabulary/types.js";

/** Installed, grammar-owned offline evidence. Deserialized metadata cannot supply semantic rules. */
export interface DuckDBOfflinePack {
  readonly id: string;
  readonly engineVersion: string;
  readonly sourceDigest: string;
}
export interface DuckDBCoreOptions extends DuckDBDialectOptions {
  readonly packs?: readonly DuckDBOfflinePack[];
}
const owners = new WeakMap<DuckDBOfflinePack, DuckDBCatalogProvider>();

/** Internal registration is only reachable through explicit installed pack modules. */
export function registerDuckDBCompatibilityPack(
  engineVersion: string,
  sourceDigest: string,
  signatures: readonly DuckDBBuiltinSignature[],
): DuckDBOfflinePack {
  const pack = Object.freeze({ id: "duckdb-compatibility", engineVersion, sourceDigest });
  owners.set(
    pack,
    createDuckDBCatalog({
      version: engineVersion,
      signatures,
      implicitCasts: [],
      commonTypes: {},
      expressionTypes: {},
    }),
  );
  return pack;
}
export function createDuckDBCoreDialect(
  core: DuckDBCatalogProvider,
  version: string,
  options: DuckDBCoreOptions = {},
  vocabulary?: DuckDBVocabulary,
) {
  let catalog = core;
  const seen = new Set<string>();
  for (const pack of options.packs ?? []) {
    const owner = owners.get(pack);
    if (!owner) throw new TypeError("DuckDB offline packs must come from an installed grammar pack export");
    if (pack.engineVersion !== version)
      throw new TypeError(`DuckDB offline pack requires engine ${pack.engineVersion}`);
    if (seen.has(pack.id)) throw new TypeError(`Duplicate DuckDB offline pack ${pack.id}`);
    seen.add(pack.id);
    catalog = extendDuckDBCatalog(catalog, owner, version);
  }
  return createDuckDBDialect(catalog, options, version, () => vocabulary);
}
