import { catalogs, emptyCatalog } from "./generated/profiles.js";

export {
  duckDBBuiltinFormalNames,
  duckDBBuiltinNonNullLiteralArguments,
  duckDBBuiltinParameterBindings,
} from "./profile.js";
export type { DuckDBBuiltinSignature } from "./types.js";
export function duckDBCatalogForVersion(version: string) {
  return Object.hasOwn(catalogs, version) ? catalogs[version]! : emptyCatalog;
}
export function duckDBBuiltinCatalog(version: string) {
  return duckDBCatalogForVersion(version).signatures;
}
export function duckDBBuiltinSignatures(version: string, name: string) {
  return duckDBCatalogForVersion(version).builtinSignatures(name);
}
export function duckDBScalarImplicitCast(version: string, source: string, target: string) {
  return duckDBCatalogForVersion(version).scalarImplicitCast(source, target);
}
export function duckDBNamedArgumentBinding(version: string) {
  return duckDBCatalogForVersion(version).namedArgumentBinding;
}
export function duckDBKeywordInvocationForms(version: string) {
  return duckDBCatalogForVersion(version).keywordInvocationForms;
}
