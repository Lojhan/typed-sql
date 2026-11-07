import { CATEGORIES, hash } from "../language-audit/inventory.mjs";
import { expandTarget } from "./corpus.mjs";

export function targetSeries(dialect, version) {
  if (dialect === "postgres") {
    const major = /^(\d+)(?:\.|beta|rc|\b)/u.exec(version)?.[1];
    if (!major) throw new Error(`Invalid native version: ${version}`);
    return major;
  }
  const parts = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(version);
  if (!parts) throw new Error(`Invalid native version: ${version}`);
  if (dialect === "sqlserver") return parts[1];
  if (dialect === "mysql") return `${parts[1]}.${parts[2]}`;
  return `${parts[1]}.${parts[2]}.${parts[3]}`;
}

// A semantic band uses only facts shared by all its captured builds/modes/profiles.
// Individual contexts remain intact in the corpus; disagreement never selects an arbitrary row.
export function groupCorpus(corpus) {
  const groups = new Map();
  for (const [id, entry] of Object.entries(corpus.targets)) {
    const version = targetSeries(entry.dialect, entry.target.version);
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
      const memberships = observed.map((entry) => new Set(entry.rows.map(hash)));
      const rows = observed[0].rows.filter((row) => memberships.every((membership) => membership.has(hash(row))));
      group.categories[name] = {
        status: "observed",
        rows,
        excludedContextRows: new Set(observed.flatMap((entry) => entry.rows.map(hash))).size - rows.length,
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
