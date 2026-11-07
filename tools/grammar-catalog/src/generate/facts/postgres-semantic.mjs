import { nativeIdentity, requireKnown } from "../../model/projection.mjs";

const optional = (fact) => (fact.status === "known" ? fact.value : null);
const native = (expression) => (expression.kind === "native" ? expression.identity : null);
export function postgresSemanticSignature(entity) {
  const routine = entity.routine;
  if (!routine || routine.parameters.status !== "known") return undefined;
  return {
    name: entity.name,
    namespace: optional(routine.namespace),
    identity: routine.identity,
    kind: optional(routine.nativeKind),
    arguments: routine.parameters.value.map((parameter) => ({
      name: optional(parameter.name),
      nativeType: native(parameter.type),
      mode: optional(parameter.nativeMode),
      hasDefault: parameter.default.kind === "unknown" ? null : parameter.default.kind !== "absent",
    })),
    result: native(routine.result.type),
    returnsSet: optional(routine.result.returnsSet),
    variadicNativeType: native(routine.variadicType),
    volatility: routine.properties.volatility,
    strict: routine.properties.strict,
  };
}
export function postgresSemanticTypes(entities, policies, categoryNames) {
  return policies.map((policy) => {
    const exact = entities.filter((entity) => entity.name === policy.name);
    const candidates = exact.length
      ? exact
      : entities.filter(
          (entity) =>
            entity.semantic.kind === "type" &&
            entity.semantic.canonical.kind === "native" &&
            entity.semantic.canonical.identity === policy.name,
        );
    if (candidates.length !== 1) throw new Error(`Missing or conflicting PostgreSQL type facts: ${policy.name}`);
    const entity = candidates[0],
      facet = entity.semantic;
    if (facet.kind !== "type") throw new TypeError(`Invalid PostgreSQL type facet: ${policy.name}`);
    const defined = requireKnown(facet.defined, `${policy.name} definition`),
      preferred = requireKnown(facet.preferred, `${policy.name} preference`),
      canonical = nativeIdentity(facet.canonical, policy.name),
      category = categoryNames[requireKnown(facet.category, `${policy.name} category`)];
    if (defined !== true || !category) throw new Error(`Incomplete PostgreSQL type facts: ${policy.name}`);
    return {
      ...policy,
      category,
      preferred,
      aliases: [...new Set([...policy.aliases, entity.name, canonical])].filter((name) => name !== policy.name).sort(),
    };
  });
}
export function postgresSemanticCasts(entities, types) {
  const aliases = new Map(types.flatMap((type) => [type.name, ...type.aliases].map((name) => [name, type.name])));
  const methods = { b: "binary", f: "function", i: "io" },
    result = [];
  for (const entity of entities) {
    const facet = entity.semantic;
    if (facet.kind !== "cast") throw new TypeError(`Invalid PostgreSQL cast facet: ${entity.name}`);
    const source = aliases.get(nativeIdentity(facet.from, entity.name)),
      target = aliases.get(nativeIdentity(facet.to, entity.name));
    if (!source || !target) continue;
    const context = requireKnown(facet.context, `${entity.name} context`),
      method = methods[requireKnown(facet.method, `${entity.name} method`)];
    if (!method) throw new Error(`Unknown PostgreSQL cast method: ${entity.name}`);
    result.push({ source, target, context, method });
  }
  return result.sort((a, b) => `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`));
}
