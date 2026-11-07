import { duckdbFormalNames, duckdbSemanticSignature } from "./duckdb-semantic.mjs";

/** Policy names semantic families/parameters; native aliases and ordinals are generated. */
export function duckdbNonNullLiteralArguments(entities, rules, version, macroPolicy = []) {
  if (!Array.isArray(rules)) throw new TypeError("Missing DuckDB literal constraint policy");
  const aliases = new Map();
  const link = (left, right) => aliases.set(left, new Set([...(aliases.get(left) ?? []), right]));
  for (const entity of entities) {
    link(entity.name, entity.name);
    const alias = entity.routine?.properties.aliasOf;
    if (typeof alias === "string" && alias) {
      link(entity.name, alias);
      link(alias, entity.name);
    }
  }
  const family = (name) => {
    const result = new Set(),
      pending = [name];
    while (pending.length) {
      const next = pending.pop();
      if (result.has(next)) continue;
      result.add(next);
      pending.push(...(aliases.get(next) ?? []));
    }
    return result;
  };
  const requirements = new Map();
  for (const rule of rules) {
    const parameters = rule.parametersByVersion?.[version] ?? rule.parameters;
    if (
      rule.rule !== "non-null-literal" ||
      !Array.isArray(rule.functions) ||
      !rule.functions.length ||
      !Array.isArray(parameters) ||
      !parameters.length ||
      parameters.some((name) => typeof name !== "string" || !name) ||
      rule.functions.some((name) => typeof name !== "string" || !name)
    )
      throw new TypeError("Invalid DuckDB literal constraint rule");
    for (const anchor of rule.functions) {
      const members = family(anchor);
      const matching = entities.filter((entity) => members.has(entity.name));
      if (!matching.some((entity) => duckdbFormalNames(entity).some((name) => parameters.includes(name))))
        throw new TypeError(`Unqualified DuckDB literal constraint: ${anchor}`);
      for (const entity of matching) {
        requirements.set(entity, new Set([...(requirements.get(entity) ?? []), ...parameters]));
      }
    }
  }
  const restrictions = new Map();
  for (const [entity, parameters] of requirements) {
    const names = duckdbFormalNames(entity);
    const key = JSON.stringify(duckdbSemanticSignature(entity, macroPolicy));
    const candidates = restrictions.get(key) ?? [];
    candidates.push(new Set(names.flatMap((name, index) => (parameters.has(name) ? [index] : []))));
    restrictions.set(key, candidates);
  }
  const result = {};
  for (const [key, alternatives] of [...restrictions].sort(([a], [b]) => a.localeCompare(b))) {
    const common = [...alternatives[0]]
      .filter((index) => alternatives.every((set) => set.has(index)))
      .sort((a, b) => a - b);
    if (common.length) result[key] = common;
  }
  return result;
}
