import { hash } from "../model/canonical.mjs";
import { commonEntities, nativeIdentity, requireKnown } from "../model/projection.mjs";
import { serialize } from "../model/serialize.mjs";
import { literal, ordered, rowsLiteral } from "./common.mjs";
import { duckdbCombinations } from "./facts/duckdb.mjs";
import { duckdbFormalNames, duckdbRoutineProjection, duckdbSemanticSignature } from "./facts/duckdb-semantic.mjs";

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

export async function generateCatalog({ groups, semanticGroups, input, emit, header }) {
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
  let duckRegistry = `${header}${duckdb.map((group, index) => `import { signatures as signatures${index}, implicitCasts as casts${index}, parameterNames as names${index}, namedArgumentBinding as binding${index}, keywordInvocationForms as keywords${index} } from "./${group.version}.js";\nimport { commonTypes as common${index}, expressionTypes as expression${index} } from "./common-${group.version}.js";`).join("\n")}\n`;
  duckRegistry += `export const nativeCatalogs = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: signatures${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeParameterNames = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: names${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeNamedArgumentBinding = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: binding${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeKeywordInvocationForms = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: keywords${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeImplicitCasts = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: casts${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeCommonTypes: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: common${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeExpressionTypes: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: expression${index}`).join(",")}};\n`;
  await emit("packages/duckdb/src/catalog/generated/registry.ts", duckRegistry);
  const duckAliases = {};
  const routineProjections = {};
  for (const group of duckdb) {
    const semantic = semanticGroups.find((value) => value.band === group.version);
    if (!semantic) throw new Error(`Missing DuckDB semantic profile: ${group.version}`);
    const types = commonEntities(semantic, "types");
    const combinations = await input(
      `combinations/${group.version}`,
      `grammar/duckdb/catalog/combinations-${group.version}.json`,
    );
    const nativeName = (name) => {
      const descriptor = combinations.aliases[name];
      if (!descriptor || combinations.unavailable.some((entry) => entry.name === name)) {
        const descriptor = types.find((entry) => entry.name === name)?.semantic;
        const logical =
          descriptor?.kind === "type" && descriptor.canonical.kind === "native"
            ? descriptor.canonical.identity
            : undefined;
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
    const routines = commonEntities(semantic, "functions");
    const signatures = ordered(routines.map((entity) => duckdbSemanticSignature(entity, duckPolicy.macroSignatures)));
    const nameGroups = new Map();
    for (const entity of routines) {
      const key = JSON.stringify(duckdbSemanticSignature(entity, duckPolicy.macroSignatures));
      nameGroups.set(key, [...(nameGroups.get(key) ?? []), duckdbFormalNames(entity)]);
    }
    const parameterNames = signatures.map((signature) => ordered(nameGroups.get(JSON.stringify(signature))));
    const binding = duckPolicy.namedArgumentBinding[group.version];
    if (
      !binding ||
      !["labels", "formal"].includes(binding.scalar) ||
      !["labels", "formal"].includes(binding.macro) ||
      Object.values(binding.overrides).some((mode) => !["labels", "formal"].includes(mode))
    )
      throw new TypeError(`Missing DuckDB named argument policy: ${group.version}`);
    const keywordInvocationForms = commonEntities(semantic, "keywords")
      .flatMap((entity) => {
        if (entity.semantic.kind !== "keyword") throw new TypeError("Invalid DuckDB keyword facet");
        return requireKnown(entity.semantic.nativeCategory, `${entity.name} keyword category`) === "unreserved"
          ? []
          : [entity.name.toLowerCase()];
      })
      .sort();
    routineProjections[group.version] = {
      qualification: "projection accounting; does not establish semantic support",
      routines: ordered(routines.map(duckdbRoutineProjection)),
    };
    const typeNames = new Map(types.map((entity) => [entity.name, nativeName(entity.name)]));
    const casts = ordered(
      commonEntities(semantic, "casts")
        .filter(
          (entity) =>
            entity.semantic.kind === "cast" &&
            entity.semantic.context.status === "known" &&
            entity.semantic.context.value === "implicit",
        )
        .map((row) => {
          const source = nativeIdentity(row.semantic.from, row.name),
            target = nativeIdentity(row.semantic.to, row.name);
          if (!typeNames.has(source) || !typeNames.has(target))
            throw new Error(`Missing DuckDB cast endpoint: ${row.name}`);
          return [typeNames.get(source), typeNames.get(target)];
        }),
    );
    const revision = hash({ signatures, casts, parameterNames, binding, keywordInvocationForms });
    await emit(
      `packages/duckdb/src/catalog/generated/${group.version}.ts`,
      `${header}// Captured facts ${revision}\nimport type { DuckDBBuiltinSignature } from "../types.js";\nexport const signatures: readonly DuckDBBuiltinSignature[] = ${rowsLiteral(signatures)};\nexport const implicitCasts: readonly (readonly [string, string])[] = ${rowsLiteral(casts)};\nexport const parameterNames: readonly (readonly (readonly (string | null)[])[])[] = ${rowsLiteral(parameterNames)};\nexport const namedArgumentBinding = ${literal(binding)} as const;\nexport const keywordInvocationForms: readonly string[] = ${literal(keywordInvocationForms)};\n`,
    );
  }
  await emit("planning/grammar-completeness/duckdb-routine-projection.json", `${serialize(routineProjections)}\n`);
  await emit(
    "packages/duckdb/src/catalog/generated/aliases.ts",
    `${header}export const nativeTypeAliases: Readonly<Record<string, string>> = ${literal(Object.fromEntries(Object.entries(duckAliases).sort(([a], [b]) => a.localeCompare(b))))};\n`,
  );
}
