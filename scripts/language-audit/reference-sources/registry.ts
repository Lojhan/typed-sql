import { createMapperRegistry } from "../../../tools/grammar-catalog/src/registry.mjs";
import type { ReferenceSource, ReferenceSourceDefinition } from "./contracts.js";

export interface ReferenceSourceRegistry {
  readonly ids: readonly string[];
  get(id: string): ReferenceSource;
  extend(contributions: readonly ReferenceSourceDefinition[]): ReferenceSourceRegistry;
}

export function createReferenceSourceRegistry(input: readonly ReferenceSourceDefinition[]): ReferenceSourceRegistry {
  const definitions = input.map((definition) => Object.freeze({ ...definition }));
  const registry = createMapperRegistry(definitions, {
    methods: ["referenceVersions", "captureVersions"],
  });
  const resolved = new Map<string, ReferenceSource>();
  for (const id of registry.ids) {
    const source = registry.get(id);
    if (
      !Number.isSafeInteger(source.minimumFunctions) ||
      source.minimumFunctions < 0 ||
      typeof source.scope !== "string" ||
      !source.scope.trim()
    )
      throw new TypeError(`Invalid reference source policy: ${id}`);
    if (source.extractFunctions !== undefined && typeof source.extractFunctions !== "function")
      throw new TypeError(`Invalid reference function extractor: ${id}`);
    const referenceVersions = source.referenceVersions();
    const captureVersions = source.captureVersions();
    for (const versions of [referenceVersions, captureVersions])
      if (
        !Array.isArray(versions) ||
        new Set(versions).size !== versions.length ||
        versions.some((version) => typeof version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(version))
      )
        throw new TypeError(`Invalid reference source versions: ${id}`);
    if (new Set([...referenceVersions, ...captureVersions]).size !== referenceVersions.length + captureVersions.length)
      throw new TypeError(`Overlapping reference and capture versions: ${id}`);
    if (referenceVersions.length && typeof source.collect !== "function")
      throw new TypeError(`Missing reference source collector: ${id}`);
    const references = Object.freeze([...referenceVersions]);
    const captures = Object.freeze([...captureVersions]);
    resolved.set(
      id,
      Object.freeze({
        ...source,
        referenceVersions: () => references,
        captureVersions: () => captures,
      }) as ReferenceSource,
    );
  }
  return Object.freeze({
    // Preserve explicit composition order for existing report/corpus consumers.
    ids: Object.freeze(definitions.map(({ id }) => id)),
    get: (id: string) => {
      registry.get(id);
      return resolved.get(id)!;
    },
    extend: (contributions: readonly ReferenceSourceDefinition[]) =>
      createReferenceSourceRegistry([...definitions.map(({ id }) => resolved.get(id)!), ...contributions]),
  });
}
