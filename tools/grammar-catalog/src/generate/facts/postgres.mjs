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
