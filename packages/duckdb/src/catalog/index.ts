import { implicitCasts as casts15, signatures as engine15 } from "./1.5.6.js";
import { implicitCasts as casts20, signatures as engine20 } from "./2.0.0.js";
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
const catalogs = Object.freeze({ "1.5.6": owned(engine15), "2.0.0": owned(engine20) });
const casts = Object.freeze({
  "1.5.6": new Set(casts15.map(([source, target]) => `${source}\0${target}`)),
  "2.0.0": new Set(casts20.map(([source, target]) => `${source}\0${target}`)),
});
const indexes = new Map<string, ReadonlyMap<string, readonly DuckDBBuiltinSignature[]>>();
export function duckDBBuiltinCatalog(version: string): readonly DuckDBBuiltinSignature[] {
  return catalogs[version as keyof typeof catalogs] ?? [];
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
  return source === target || (casts[version as keyof typeof casts]?.has(`${source}\0${target}`) ?? false);
}
