/** Explicit registrations keep the pipeline independent of grammar names and plugin lists. */
export function createMapperRegistry(definitions) {
  const pending = new Map();
  for (const definition of definitions) {
    if (!definition || !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u.test(definition.id))
      throw new TypeError("A catalog mapper requires a canonical ID");
    if (pending.has(definition.id)) throw new TypeError(`Duplicate catalog mapper: ${definition.id}`);
    pending.set(definition.id, Object.freeze({ ...definition }));
  }
  const resolved = new Map();
  function get(id, ancestors = new Set()) {
    if (resolved.has(id)) return resolved.get(id);
    const definition = pending.get(id);
    if (!definition) throw new TypeError(`Unregistered catalog mapper: ${id}`);
    if (ancestors.has(id)) throw new TypeError(`Cyclic catalog mapper contribution: ${id}`);
    const next = new Set(ancestors).add(id);
    const parent = definition.extends === undefined ? {} : get(definition.extends, next);
    const mapper = Object.freeze({ ...parent, ...definition });
    for (const method of ["versionBand", "routineFacts", "normalizeRow"])
      if (typeof mapper[method] !== "function") throw new TypeError(`Missing catalog mapper ${id}.${method}`);
    resolved.set(id, mapper);
    return mapper;
  }
  for (const id of pending.keys()) get(id);
  return Object.freeze({
    ids: Object.freeze([...resolved.keys()].sort()),
    get: (id) => get(id),
    extend: (contributions) => createMapperRegistry([...pending.values(), ...contributions]),
  });
}

export function numericVersionBand(components) {
  if (!Number.isSafeInteger(components) || components < 1 || components > 3)
    throw new TypeError("Invalid version band width");
  return (version) => {
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.|beta|rc|\b)/u.exec(version);
    if (!match || match.slice(1, components + 1).some((part) => part === undefined))
      throw new TypeError(`Invalid catalog version: ${version}`);
    return match.slice(1, components + 1).join(".");
  };
}

/** A contribution declares which native fields identify overloads; missing identity evidence fails extraction. */
export function identityFields(categories) {
  const fields = Object.fromEntries(Object.entries(categories).map(([category, names]) => [category, [...names]]));
  return (category, row) => {
    const names = fields[category];
    if (!names) return undefined;
    if (names.some((name) => !Object.hasOwn(row, name)))
      throw new TypeError(`Missing native identity field: ${category}`);
    return { identity: JSON.stringify(names.map((name) => row[name])), knowledge: "native-fields" };
  };
}
