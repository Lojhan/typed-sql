import { readFile } from "node:fs/promises";
import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";

const readReference = async (dialect, version) => {
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(dialect) ||
    dialect.split("/").some((part) => part === "." || part === "..") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(version)
  )
    throw new TypeError("Invalid recognition reference path");
  return JSON.parse(
    await readFile(new URL(`../../test/fixtures/language-audit/${dialect}-${version}.json`, import.meta.url), "utf8"),
  );
};

/** Registered version owners select fallback references; shared enrichment has no engine cases. */
export async function recognitionRows(input, { mappers = builtinMappers, reference = readReference } = {}) {
  const functions = input.categories.functions,
    rows = functions?.rows ?? [];
  if (rows.length && functions.scope !== "system-objects-only") return rows;
  const version = mappers.get(input.dialect).versionBand(input.target.version);
  if (typeof version !== "string" || !version) throw new TypeError("Invalid recognition reference identity");
  const captured = await reference(input.dialect, version);
  if (
    captured.dialect !== input.dialect ||
    captured.target?.version !== version ||
    !Array.isArray(captured.categories?.functions?.rows)
  )
    throw new TypeError("Recognition reference identity or function inventory differs");
  return [...rows, ...captured.categories.functions.rows];
}
