import type { DuckDBBuiltinSignature } from "./types.js";

/** Installed grammar facts; selecting data does not supply new semantic rules. */
export interface DuckDBCatalogProvider {
  readonly versions: readonly string[];
  catalog(version: string): readonly DuckDBBuiltinSignature[];
  signatures(version: string, name: string): readonly DuckDBBuiltinSignature[];
  hasBuiltin(version: string, name: string): boolean;
  permitsBuiltin(version: string, name: string): boolean;
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
  readonly knownBuiltinNames?: readonly string[];
  readonly selection?: readonly string[];
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
  const known = new Set(input.knownBuiltinNames ?? signatures.map((signature) => signature[0]));
  const selection = input.selection === undefined ? undefined : new Set(input.selection);
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
    hasBuiltin(selected: string, name: string) {
      return selected === version && known.has(name);
    },
    permitsBuiltin(selected: string, name: string) {
      return selected === version && (selection === undefined || selection.has(name));
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
    hasBuiltin(version: string, name: string) {
      return owners.get(version)?.hasBuiltin(version, name) ?? false;
    },
    permitsBuiltin(version: string, name: string) {
      return owners.get(version)?.permitsBuiltin(version, name) ?? false;
    },
    implicitCast(version: string, source: string, target: string) {
      return source === target || owners.get(version)?.implicitCast(version, source, target) === true;
    },
    combinations(version: string, mode: "expression" | "set") {
      return owners.get(version)?.combinations(version, mode) ?? emptyCombinations;
    },
  });
}

/** Extend one engine with an installed disjoint partition; shared casts and type mechanics stay in core. */
export function extendDuckDBCatalog(
  core: DuckDBCatalogProvider,
  additional: DuckDBCatalogProvider,
  version: string,
): DuckDBCatalogProvider {
  for (const signature of additional.catalog(version))
    if (core.signatures(version, signature[0]).length)
      throw new TypeError(`Overlapping DuckDB offline family ${signature[0]}`);
  let catalog: readonly DuckDBBuiltinSignature[] | undefined;
  return Object.freeze({
    versions: Object.freeze([version]),
    catalog(selected: string) {
      if (selected !== version) return emptySignatures;
      catalog ??= Object.freeze(
        [...core.catalog(version), ...additional.catalog(version)].sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        ),
      );
      return catalog;
    },
    signatures(selected: string, name: string) {
      const existing = core.signatures(selected, name);
      return existing.length ? existing : additional.signatures(selected, name);
    },
    hasBuiltin(selected: string, name: string) {
      return core.hasBuiltin(selected, name) || additional.hasBuiltin(selected, name);
    },
    permitsBuiltin(selected: string, name: string) {
      return core.permitsBuiltin(selected, name) || additional.permitsBuiltin(selected, name);
    },
    implicitCast(selected: string, source: string, target: string) {
      return core.implicitCast(selected, source, target);
    },
    combinations(selected: string, mode: "expression" | "set") {
      return core.combinations(selected, mode);
    },
  });
}
