import { hash } from "../model/canonical.mjs";
import { literal, ordered, rowsLiteral } from "./common.mjs";
import { duckdbCombinations, duckdbSignature } from "./facts/duckdb.mjs";

/** Canonical scalar keys come from captured aliases, never the generated runtime parser. */
export function scalarTypeName(source, aliases, spellings) {
  let spelling = source.trim().replace(/\s+/gu, " ").toUpperCase();
  const decimal = /^DECIMAL\(\s*(\d+)\s*,\s*(\d+)\s*\)$/u.exec(spelling);
  if (decimal) {
    const precision = Number(decimal[1]),
      scale = Number(decimal[2]);
    if (!Number.isSafeInteger(precision) || precision < 1 || precision > 38 || scale < 0 || scale > precision)
      throw new TypeError(`Invalid native DECIMAL endpoint: ${source}`);
    spelling = "DECIMAL";
  }
  const name = spellings[spelling] ?? aliases[spelling] ?? spelling;
  if (!/^[A-Z_][A-Z_0-9]*$/u.test(name)) throw new TypeError(`Non-scalar native cast endpoint: ${source}`);
  return name;
}

export async function generateCatalog({ groups, input, emit, header }) {
  const policy = await input("policy", "grammar/duckdb/catalog/policy.json");
  if (policy.formatVersion !== 1) throw new Error("Unsupported duckdb generation policy");
  const duckTypeName = (source) => scalarTypeName(source, duckAliases, policy.typeSpellings);
  const duckdb = groups;
  const duckPolicy = policy;
  if (
    duckPolicy.formatVersion !== 1 ||
    new Set(duckPolicy.macroSignatures.map((entry) => entry.name)).size !== duckPolicy.macroSignatures.length
  )
    throw new Error("Invalid DuckDB macro policy");
  let duckRegistry = `${header}${duckdb.map((group, index) => `import { signatures as signatures${index}, implicitCasts as casts${index} } from "./${group.version}.js";\nimport { commonTypes as common${index}, expressionTypes as expression${index} } from "./common-${group.version}.js";`).join("\n")}\n`;
  duckRegistry += `export const nativeCatalogs = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: signatures${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeImplicitCasts = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: casts${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeCommonTypes: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: common${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeExpressionTypes: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: expression${index}`).join(",")}};\n`;
  await emit("packages/duckdb/src/catalog/generated/registry.ts", duckRegistry);
  const duckAliases = {};
  for (const group of duckdb) {
    const combinations = await input(
      `combinations/${group.version}`,
      `grammar/duckdb/catalog/combinations-${group.version}.json`,
    );
    const nativeName = (name) => {
      const descriptor = combinations.aliases[name];
      if (!descriptor || combinations.unavailable.some((entry) => entry.name === name)) {
        const logical = group.categories.types.rows.find((entry) => entry.name === name)?.logical_type;
        return ["NULL", "ANY", "INVALID", "UNKNOWN"].includes(logical) ? logical : duckTypeName(name);
      }
      const spelling = descriptor.replace(/\(.*\)$/u, "");
      return duckTypeName(duckPolicy.typeSpellings[spelling] ?? spelling);
    };
    for (const [alias, nativeType] of Object.entries(combinations.aliases)) {
      if (combinations.unavailable.some((entry) => entry.name === alias)) continue;
      const spelling = nativeType.replace(/\(.*\)$/u, "");
      const canonical = duckPolicy.typeSpellings[spelling] ?? spelling;
      const name = alias.toUpperCase();
      if (duckAliases[name] && duckAliases[name] !== canonical)
        throw new Error(`Conflicting DuckDB type alias: ${alias}`);
      if (name !== canonical) duckAliases[name] = canonical;
    }
    const matrices = duckdbCombinations(combinations, group.version, nativeName);
    await emit(
      `packages/duckdb/src/catalog/generated/common-${group.version}.ts`,
      `${header}export const commonTypes: Readonly<Record<string, string | null>> = ${literal(matrices.set)};\nexport const expressionTypes: Readonly<Record<string, string | null>> = ${literal(matrices.expression)};\n`,
    );
    const signatures = ordered(
      group.categories.functions.rows.map((row) => duckdbSignature(row, duckPolicy.macroSignatures)),
    );
    const typeNames = new Map(group.categories.types.rows.map((row) => [row.name, nativeName(row.name)]));
    const casts = ordered(
      group.categories.casts.rows
        .filter((row) => row.implicit)
        .map((row) => {
          const [source, target] = row.name.split(" -> ");
          if (!typeNames.has(source) || !typeNames.has(target))
            throw new Error(`Missing DuckDB cast endpoint: ${row.name}`);
          return [typeNames.get(source), typeNames.get(target)];
        }),
    );
    const revision = hash({ signatures, casts });
    await emit(
      `packages/duckdb/src/catalog/generated/${group.version}.ts`,
      `${header}// Captured facts ${revision}\nimport type { DuckDBBuiltinSignature } from "../types.js";\nexport const signatures: readonly DuckDBBuiltinSignature[] = ${rowsLiteral(signatures)};\nexport const implicitCasts: readonly (readonly [string, string])[] = ${rowsLiteral(casts)};\n`,
    );
  }
  await emit(
    "packages/duckdb/src/catalog/generated/aliases.ts",
    `${header}export const nativeTypeAliases: Readonly<Record<string, string>> = ${literal(Object.fromEntries(Object.entries(duckAliases).sort(([a], [b]) => a.localeCompare(b))))};\n`,
  );
}
