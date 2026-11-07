import { nativeCatalogs, nativeImplicitCasts } from "./generated/registry.js";
import type { DuckDBBuiltinSignature } from "./types.js";

export type { DuckDBBuiltinSignature } from "./types.js";

function owned(values: readonly DuckDBBuiltinSignature[]): readonly DuckDBBuiltinSignature[] {
  return Object.freeze(
    values.map(
      (value) =>
        Object.freeze([
          value[0],
          value[1],
          Object.freeze([...value[2]]),
          value[3],
          value[4],
          value[5],
          value[6],
        ]) as DuckDBBuiltinSignature,
    ),
  );
}
const catalogs = new Map(Object.entries(nativeCatalogs).map(([version, values]) => [version, owned(values)]));
const casts = new Map(
  Object.entries(nativeImplicitCasts).map(([version, values]) => [
    version,
    new Set(values.map(([source, target]) => `${source}\0${target}`)),
  ]),
);
const indexes = new Map<string, ReadonlyMap<string, readonly DuckDBBuiltinSignature[]>>();
export function duckDBBuiltinCatalog(version: string): readonly DuckDBBuiltinSignature[] {
  return catalogs.get(version) ?? [];
}
export function duckDBBuiltinSignatures(version: string, name: string): readonly DuckDBBuiltinSignature[] {
  let index = indexes.get(version);
  if (!index) {
    const values = new Map<string, DuckDBBuiltinSignature[]>();
    for (const signature of duckDBBuiltinCatalog(version)) {
      const bucket = values.get(signature[0]) ?? [];
      bucket.push(signature);
      values.set(signature[0], bucket);
    }
    index = new Map([...values].map(([name, bucket]) => [name, Object.freeze(bucket)]));
    indexes.set(version, index);
  }
  return index.get(name) ?? [];
}
export function duckDBScalarImplicitCast(version: string, source: string, target: string): boolean {
  return source === target || (casts.get(version)?.has(`${source}\0${target}`) ?? false);
}
