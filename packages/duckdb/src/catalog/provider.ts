import type { DuckDBBuiltinSignature } from "./types.js";

/** Installed grammar facts; selecting data does not supply new semantic rules. */
export interface DuckDBCatalogProvider {
  readonly versions: readonly string[];
  catalog(version: string): readonly DuckDBBuiltinSignature[];
  signatures(version: string, name: string): readonly DuckDBBuiltinSignature[];
  implicitCast(version: string, source: string, target: string): boolean;
  combinations(version: string, mode: "expression" | "set"): Readonly<Record<string, string | null>>;
}

const emptySignatures: readonly DuckDBBuiltinSignature[] = Object.freeze([]);
const emptyCombinations: Readonly<Record<string, string | null>> = Object.freeze({});

/** Own one exact engine's data without importing another engine or an optional native SDK. */
export function createDuckDBCatalog(input: {
  readonly version: string;
  readonly signatures: readonly DuckDBBuiltinSignature[];
  readonly implicitCasts: readonly (readonly [string, string])[];
  readonly commonTypes: Readonly<Record<string, string | null>>;
  readonly expressionTypes: Readonly<Record<string, string | null>>;
}): DuckDBCatalogProvider {
  const signatures = Object.freeze(
    input.signatures.map(
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
  let index: ReadonlyMap<string, readonly DuckDBBuiltinSignature[]> | undefined;
  const byName = () => {
    if (index) return index;
    const groups = new Map<string, DuckDBBuiltinSignature[]>();
    for (const signature of signatures) {
      const bucket = groups.get(signature[0]) ?? [];
      bucket.push(signature);
      groups.set(signature[0], bucket);
    }
    index = new Map([...groups].map(([name, values]) => [name, Object.freeze(values)]));
    return index;
  };
  const casts = new Set(input.implicitCasts.map(([source, target]) => `${source}\0${target}`));
  const common = Object.freeze({ ...input.commonTypes }),
    expression = Object.freeze({ ...input.expressionTypes }),
    version = input.version;
  return Object.freeze({
    versions: Object.freeze([version]),
    catalog(selected: string) {
      return selected === version ? signatures : emptySignatures;
    },
    signatures(selected: string, name: string) {
      return selected === version ? (byName().get(name) ?? emptySignatures) : emptySignatures;
    },
    implicitCast(selected: string, source: string, target: string) {
      return source === target || (selected === version && casts.has(`${source}\0${target}`));
    },
    combinations(selected: string, mode: "expression" | "set") {
      return selected === version ? (mode === "set" ? common : expression) : emptyCombinations;
    },
  });
}

/** Compatibility analyzers retain all existing qualified engines without merging their facts. */
export function combineDuckDBCatalogs(providers: readonly DuckDBCatalogProvider[]): DuckDBCatalogProvider {
  const owners = new Map<string, DuckDBCatalogProvider>();
  for (const provider of providers)
    for (const version of provider.versions) {
      if (owners.has(version)) throw new TypeError(`Duplicate DuckDB catalog for ${version}`);
      owners.set(version, provider);
    }
  return Object.freeze({
    versions: Object.freeze([...owners.keys()]),
    catalog(version: string) {
      return owners.get(version)?.catalog(version) ?? emptySignatures;
    },
    signatures(version: string, name: string) {
      return owners.get(version)?.signatures(version, name) ?? emptySignatures;
    },
    implicitCast(version: string, source: string, target: string) {
      return source === target || owners.get(version)?.implicitCast(version, source, target) === true;
    },
    combinations(version: string, mode: "expression" | "set") {
      return owners.get(version)?.combinations(version, mode) ?? emptyCombinations;
    },
  });
}
