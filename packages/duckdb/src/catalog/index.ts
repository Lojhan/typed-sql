import { duckDBCatalog as engine15 } from "./engines/1.5.6.js";
import { duckDBCatalog as engine20 } from "./engines/2.0.0.js";
import { combineDuckDBCatalogs } from "./provider.js";
import type { DuckDBBuiltinSignature } from "./types.js";

export type { DuckDBBuiltinSignature } from "./types.js";

export const defaultDuckDBCatalog = combineDuckDBCatalogs([engine15, engine20]);

export function duckDBBuiltinCatalog(version: string): readonly DuckDBBuiltinSignature[] {
  return defaultDuckDBCatalog.catalog(version);
}
export function duckDBBuiltinSignatures(version: string, name: string): readonly DuckDBBuiltinSignature[] {
  return defaultDuckDBCatalog.signatures(version, name);
}
export function duckDBScalarImplicitCast(version: string, source: string, target: string): boolean {
  return defaultDuckDBCatalog.implicitCast(version, source, target);
}
