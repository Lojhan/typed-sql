import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { builtinDiscoveryRegistry } from "./discovery/index.mjs";
import { CATEGORIES, hash, inventory, unavailable } from "./records.mjs";
import { signatureFacts } from "./signatures.mjs";

export { canonicalDuckFunction } from "./discovery/duckdb.mjs";
export { CATEGORIES, hash, inventory, serialize, unavailable } from "./records.mjs";
export const DIALECTS = Object.freeze([...builtinDiscoveryRegistry.ids]);
export const QUERIES = Object.freeze(
  Object.fromEntries(DIALECTS.map((id) => [id, builtinDiscoveryRegistry.get(id).discoveryQueries()])),
);
export function reviewTarget(input, registry = builtinMappers) {
  return registry.get(input.dialect).reviewTarget?.(input.target) ?? input.target;
}

export async function collectLive(dialect, query, target, registry = builtinDiscoveryRegistry) {
  const mapper = registry.get(dialect);
  if (typeof target.version !== "string" || !target.version) throw new Error("Actual engine version is required");
  /** @type {Record<string, {status: string, scope?: string, source?: string, fingerprint?: string, rows?: {name: string, [key: string]: unknown}[], reason?: string, unprobeableTypes?: string[]}>} */
  const categories = {};
  const queries = mapper.discoveryQueries();
  if (!queries || typeof queries !== "object" || Array.isArray(queries))
    throw new TypeError("Invalid discovery query map");
  for (const [category, sql] of Object.entries(queries))
    if (!CATEGORIES.includes(category) || typeof sql !== "string" || !sql.trim())
      throw new TypeError(`Invalid discovery query: ${category}`);
  for (const category of CATEGORIES) {
    const sql = queries[category];
    categories[category] = sql
      ? inventory(
          (await query(sql)).map((row) => {
            const native = mapper.discoveryRow(category, row);
            return category === "functions"
              ? { ...native, signature: signatureFacts(dialect, native, registry) }
              : native;
          }),
          sql,
          mapper.discoveryScope(category),
        )
      : unavailable(mapper.discoveryLimitation(category));
  }
  await mapper.discoveryDerived({ categories, query, target, inventory });
  if (Object.keys(categories).some((category) => !CATEGORIES.includes(category)))
    throw new TypeError("Unknown derived discovery category");
  for (const category of CATEGORIES) {
    const value = categories[category];
    if (value.status === "observed") {
      if (
        !Array.isArray(value.rows) ||
        !value.rows.length ||
        hash(value.rows) !== value.fingerprint ||
        typeof value.source !== "string" ||
        !value.source.trim() ||
        typeof value.scope !== "string" ||
        !value.scope.trim()
      )
        throw new TypeError(`Invalid discovered inventory: ${category}`);
    } else if (value.status !== "unavailable" || typeof value.reason !== "string" || !value.reason.trim())
      throw new TypeError(`Invalid discovery limitation: ${category}`);
  }
  return { formatVersion: 1, dialect, target, categories };
}

export function diffInventory(previous, next, registry = builtinMappers) {
  if (previous.dialect !== next.dialect || previous.target.version !== next.target.version)
    throw new Error("Inventory targets must match exactly");
  const changes = [];
  if (hash(reviewTarget(previous, registry)) !== hash(reviewTarget(next, registry)))
    changes.push({ category: "target", kind: "context-changed", before: previous.target, after: next.target });
  if (hash(previous.recognition ?? null) !== hash(next.recognition ?? null))
    changes.push({
      category: "recognition",
      kind: "behavior-changed",
      before: previous.recognition ?? null,
      after: next.recognition ?? null,
    });
  for (const category of CATEGORIES) {
    const left = previous.categories[category],
      right = next.categories[category];
    if (!left || !right) throw new Error(`Missing category ${category}`);
    if (left.status !== right.status)
      changes.push({ category, kind: "coverage-changed", before: left.status, after: right.status });
    if (left.status === "unavailable" && right.status === "unavailable" && left.reason !== right.reason)
      changes.push({ category, kind: "limitation-changed", before: left.reason, after: right.reason });
    if (left.status === "observed" && right.status === "observed") {
      if (left.scope !== right.scope || hash(left.unprobeableTypes ?? []) !== hash(right.unprobeableTypes ?? []))
        changes.push({ category, kind: "coverage-changed", before: left.scope, after: right.scope });
      const a = new Set(left.rows.map((row) => JSON.stringify(row)));
      const b = new Set(right.rows.map((row) => JSON.stringify(row)));
      for (const value of b) if (!a.has(value)) changes.push({ category, kind: "added", value: JSON.parse(value) });
      for (const value of a) if (!b.has(value)) changes.push({ category, kind: "removed", value: JSON.parse(value) });
    }
  }
  return changes;
}
