// Compatibility adapter only; production emission consumes normalized routine entities.
import { duckdbMapper } from "../../mappers/duckdb.mjs";
import { describeRoutine } from "../../model/build.mjs";
import { routineSignature } from "../../model/routines.mjs";
import { duckdbSemanticSignature } from "./duckdb-semantic.mjs";

export function duckdbSignature(row, macroPolicy = []) {
  return duckdbSemanticSignature(
    {
      name: row.name,
      routine: describeRoutine(routineSignature(duckdbMapper, row), duckdbMapper),
    },
    macroPolicy,
  );
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
