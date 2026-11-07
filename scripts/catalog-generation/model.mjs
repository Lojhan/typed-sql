import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { routineSignature } from "../../tools/grammar-catalog/src/model/routines.mjs";
import { CATEGORIES, hash } from "../language-audit/inventory.mjs";
import { expandTarget } from "./corpus.mjs";

export function targetSeries(dialect, version, registry = builtinMappers) {
  return registry.get(dialect).versionBand(version);
}

// A semantic band uses only facts shared by all its captured builds/modes/profiles.
// Individual contexts remain intact in the corpus; disagreement never selects an arbitrary row.
export function groupCorpus(corpus, registry = builtinMappers) {
  const groups = new Map();
  for (const [id, entry] of Object.entries(corpus.targets)) {
    const version = targetSeries(entry.dialect, entry.target.version, registry);
    const key = `${entry.dialect}/${version}`;
    const group = groups.get(key) ?? { dialect: entry.dialect, version, contexts: [], categories: {} };
    group.contexts.push({ id, capture: expandTarget(corpus, entry) });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.contexts.sort((a, b) => a.id.localeCompare(b.id));
    for (const name of CATEGORIES) {
      const observed = group.contexts.map(({ capture }) => capture.categories[name]);
      if (observed.some((entry) => entry.status !== "observed")) {
        group.categories[name] = {
          status: "unavailable",
          reasons: [...new Set(observed.map((entry) => entry.reason).filter(Boolean))],
        };
        continue;
      }
      const mapper = registry.get(group.dialect);
      const normalized = observed.map((entry) => [
        ...new Map(
          entry.rows.map((raw) => {
            const row = mapper.normalizeRow(name, raw);
            const value =
              name === "functions" && row.signature ? { ...row, signature: routineSignature(mapper, row) } : row;
            return [hash(value), value];
          }),
        ).values(),
      ]);
      const memberships = normalized.map((rows) => new Set(rows.map(hash)));
      const rows = normalized[0].filter((row) => memberships.every((membership) => membership.has(hash(row))));
      group.categories[name] = {
        status: "observed",
        rows,
        excludedContextRows: new Set(normalized.flatMap((rows) => rows.map(hash))).size - rows.length,
      };
    }
  }
  return [...groups.values()].sort((a, b) =>
    `${a.dialect}/${a.version}`.localeCompare(`${b.dialect}/${b.version}`, undefined, { numeric: true }),
  );
}

export function postgresSignature(row) {
  const signature = row.signature;
  if (!signature || !Array.isArray(signature.parameters)) return undefined;
  return {
    name: row.name,
    namespace: signature.namespace,
    identity: signature.identity,
    kind: signature.kind,
    arguments: signature.parameters.map((parameter) => ({
      name: parameter.name,
      nativeType: parameter.nativeType,
      mode: parameter.mode,
      hasDefault: parameter.hasDefault,
    })),
    result: signature.result.nativeType,
    returnsSet: signature.result.returnsSet,
    variadicNativeType: signature.variadicNativeType,
    volatility: signature.properties.volatility,
    strict: signature.properties.strict,
  };
}

export function duckdbSignature(row, macroPolicy = []) {
  if (!Array.isArray(row.arguments)) throw new Error(`Missing native DuckDB parameter list: ${row.name}`);
  const override = row.kind === "macro" ? macroPolicy.find((entry) => entry.name === row.name) : undefined;
  if (
    override &&
    (override.semantics !== "specialized-resolver" || override.parameters.length !== row.arguments.length)
  )
    throw new Error(`Macro policy conflicts with native shape: ${row.name}`);
  return [
    row.name,
    row.kind,
    override?.parameters ?? row.arguments,
    row.result,
    row.varargs,
    row.stability,
    row.side_effects,
  ];
}

export function postgresCasts(rows, types) {
  const aliases = new Map(types.flatMap((type) => [type.name, ...type.aliases].map((name) => [name, type.name])));
  const contexts = { i: "implicit", a: "assignment", e: "explicit" };
  const methods = { b: "binary", f: "function", i: "io" };
  const result = [];
  for (const row of rows) {
    const [source, target] = row.name.split(" -> ").map((name) => aliases.get(name));
    if (!source || !target) continue;
    if (!contexts[row.context] || !methods[row.method])
      throw new Error(`Unknown PostgreSQL cast semantics: ${row.name}`);
    result.push({ source, target, context: contexts[row.context], method: methods[row.method] });
  }
  return result.sort((a, b) => `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`));
}

export function postgresTypes(rows, policies, categoryNames) {
  return policies.map((policy) => {
    const matches = rows.filter((row) => row.name === policy.name);
    const candidates = matches.length ? matches : rows.filter((row) => row.canonical_name === policy.name);
    if (candidates.length !== 1) throw new Error(`Missing or conflicting PostgreSQL type facts: ${policy.name}`);
    const native = candidates[0];
    const category = categoryNames[native.category];
    if (native.defined !== true || typeof native.preferred !== "boolean" || !category || !native.canonical_name)
      throw new Error(`Incomplete PostgreSQL type facts: ${policy.name}`);
    return {
      ...policy,
      category,
      preferred: native.preferred,
      aliases: [...new Set([...policy.aliases, native.name, native.canonical_name])]
        .filter((name) => name !== policy.name)
        .sort(),
    };
  });
}

export function duckdbCombinations(facts, version, canonicalName) {
  if (facts.formatVersion !== 1 || facts.version !== version || !facts.inventoryFingerprint || !facts.source)
    throw new Error(`Missing native DuckDB combination provenance: ${version}`);
  /** @type {Record<"set" | "expression", Record<string, string | null>>} */
  const result = { set: {}, expression: {} };
  for (const mode of ["set", "expression"]) {
    const entries = facts.matrices[mode];
    const names = new Set(entries.map((entry) => entry.left));
    const pairs = new Set();
    const table = {};
    for (const entry of entries) {
      const identity = JSON.stringify([entry.left, entry.right]);
      if (
        pairs.has(identity) ||
        !names.has(entry.right) ||
        !(entry.result === null || typeof entry.result === "string")
      )
        throw new Error(`Invalid native DuckDB ${mode} combination: ${identity}`);
      pairs.add(identity);
      const key = `${canonicalName(entry.left)}|${canonicalName(entry.right)}`;
      if (Object.hasOwn(table, key) && table[key] !== entry.result)
        throw new Error(`Conflicting canonical DuckDB ${mode} combination: ${key}`);
      table[key] = entry.result;
    }
    if (!names.size || pairs.size !== names.size ** 2) throw new Error(`Incomplete DuckDB ${mode} matrix`);
    result[mode] = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
  }
  return result;
}
