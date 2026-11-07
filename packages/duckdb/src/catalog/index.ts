import {
  nativeCatalogs,
  nativeImplicitCasts,
  nativeKeywordInvocationForms,
  nativeNamedArgumentBinding,
  nativeParameterNames,
} from "./generated/registry.js";
import type { DuckDBBuiltinSignature } from "./types.js";

export type { DuckDBBuiltinSignature } from "./types.js";

type FormalNames = readonly (readonly (string | null)[])[];
const formalNames = new WeakMap<DuckDBBuiltinSignature, FormalNames>();
function owned(
  values: readonly DuckDBBuiltinSignature[],
  names: readonly FormalNames[],
): readonly DuckDBBuiltinSignature[] {
  if (values.length !== names.length) throw new TypeError("DuckDB formal-name inventory does not match signatures");
  return Object.freeze(
    values.map((value, index) => {
      const signature = Object.freeze([
        value[0],
        value[1],
        Object.freeze([...value[2]]),
        value[3],
        value[4],
        value[5],
        value[6],
      ]) as DuckDBBuiltinSignature;
      formalNames.set(signature, Object.freeze(names[index]!.map((row) => Object.freeze([...row]))));
      return signature;
    }),
  );
}
const catalogs = new Map(
  Object.entries(nativeCatalogs).map(([version, values]) => [
    version,
    owned(values, nativeParameterNames[version as keyof typeof nativeParameterNames]),
  ]),
);
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

export function duckDBBuiltinFormalNames(signature: DuckDBBuiltinSignature): FormalNames {
  return formalNames.get(signature) ?? [];
}
export function duckDBNamedArgumentBinding(version: string) {
  return nativeNamedArgumentBinding[version as keyof typeof nativeNamedArgumentBinding];
}
export function duckDBKeywordInvocationForms(version: string): readonly string[] {
  return nativeKeywordInvocationForms[version as keyof typeof nativeKeywordInvocationForms] ?? [];
}
