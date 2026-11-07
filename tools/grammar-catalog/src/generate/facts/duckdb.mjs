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
