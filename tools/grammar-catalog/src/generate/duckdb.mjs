import { hash } from "../model/canonical.mjs";
import { commonEntities, nativeIdentity, requireKnown } from "../model/projection.mjs";
import { serialize } from "../model/serialize.mjs";
import { checkLockedFacts } from "../provenance/source-lock.mjs";
import { validateSourceFacts } from "../sources/duckdb/facts.mjs";
import { sourceRoutine } from "../sources/duckdb/model.mjs";
import { literal, ordered, rowsLiteral } from "./common.mjs";
import { duckdbCombinations } from "./facts/duckdb.mjs";
import { duckdbBindingKey, duckdbSourceBinding } from "./facts/duckdb-binding.mjs";
import { duckdbNonNullLiteralArguments } from "./facts/duckdb-constraints.mjs";
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
  const sourceFacts = await input("source-facts", "grammar/duckdb/facts/catalog.json");
  const sourceLock = await input("source-lock", "grammar/duckdb/sources.lock.json");
  checkLockedFacts(sourceLock, sourceFacts, validateSourceFacts);
  if (policy.formatVersion !== 1) throw new Error("Unsupported duckdb generation policy");
  const duckTypeName = (source) => scalarTypeName(source, duckAliases, policy.typeSpellings);
  const duckdb = groups;
  const duckPolicy = policy;
  if (
    duckPolicy.formatVersion !== 1 ||
    new Set(duckPolicy.macroSignatures.map((entry) => entry.name)).size !== duckPolicy.macroSignatures.length
  )
    throw new Error("Invalid DuckDB macro policy");
  if (
    !duckPolicy.explicitInvocationArity ||
    Object.entries(duckPolicy.explicitInvocationArity).some(
      ([name, count]) => !/^[a-z_][a-z_0-9]*$/u.test(name) || !Number.isSafeInteger(count) || Number(count) < 0,
    )
  )
    throw new TypeError("Invalid DuckDB explicit invocation arity policy");
  let duckRegistry = `${header}${duckdb.map((group, index) => `import { signatures as signatures${index}, implicitCasts as casts${index}, parameterNames as names${index}, namedArgumentBinding as binding${index}, keywordInvocationForms as keywords${index}, nonNullLiteralArguments as nulls${index} } from "./${group.version}.js";\nimport { commonTypes as common${index}, expressionTypes as expression${index} } from "./common-${group.version}.js";`).join("\n")}\n`;
  duckRegistry += `export const nativeCatalogs = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: signatures${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeParameterNames = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: names${index}`).join(",")}};\n`;
  duckRegistry += `${duckdb.map((group, index) => `import { parameterBindings as parameters${index} } from "./${group.version}.js";`).join("\n")}\nexport const nativeParameterBindings = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: parameters${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeNamedArgumentBinding = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: binding${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeNonNullLiteralArguments: Readonly<Record<string, Readonly<Record<number, readonly number[]>>>> = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: nulls${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeKeywordInvocationForms = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: keywords${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeImplicitCasts = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: casts${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeCommonTypes: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: common${index}`).join(",")}};\n`;
  duckRegistry += `export const nativeExpressionTypes: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {${duckdb.map((group, index) => `${JSON.stringify(group.version)}: expression${index}`).join(",")}};\n`;
  duckRegistry += `export const explicitInvocationArity: Readonly<Record<string, number>> = ${literal(duckPolicy.explicitInvocationArity)};\n`;
  if (groups.some((group) => !["untyped", "declared"].includes(duckPolicy.tableConstantNullTyping?.[group.version])))
    throw new TypeError("Missing DuckDB table constant-NULL typing policy");
  duckRegistry += `export const tableConstantNullTyping: Readonly<Record<string, string>> = ${literal(duckPolicy.tableConstantNullTyping)};\n`;
  await emit("packages/duckdb/src/catalog/generated/registry.ts", duckRegistry);
  await emit(
    "packages/duckdb/src/catalog/generated/invocation-policy.ts",
    `${header}export const explicitInvocationArity: Readonly<Record<string,number>> = ${literal(duckPolicy.explicitInvocationArity)};\n`,
  );
  for (const group of duckdb) {
    const version = JSON.stringify(group.version);
    await emit(
      `packages/duckdb/src/catalog/generated/profiles/${group.version}.ts`,
      `${header}import * as native from "../${group.version}.js";\nimport {commonTypes,expressionTypes} from "../common-${group.version}.js";\nimport {explicitInvocationArity} from "../invocation-policy.js";\nimport {DuckDBCatalog} from "../../profile.js";\nexport const catalog = new DuckDBCatalog({...native,version:${version},commonTypes,expressionTypes,explicitInvocationArity,tableConstantNullTyping:${JSON.stringify(duckPolicy.tableConstantNullTyping[group.version])}});\n`,
    );
    await emit(
      `packages/duckdb/src/analysis/generated/${group.version}.ts`,
      `${header}import {createDuckDBAnalyzer} from "../../analysis-factory.js";\nimport {catalog} from "../../catalog/generated/profiles/${group.version}.js";\nimport type {DuckDBProfileOptions as DuckDBDialectOptions} from "../../profile.js";\nexport type {DuckDBProfileOptions as DuckDBDialectOptions} from "../../profile.js";\nexport function duckdb(options:DuckDBDialectOptions={}) {return createDuckDBAnalyzer(options,()=>catalog,${version});}\n`,
    );
  }
  await emit(
    "packages/duckdb/src/catalog/generated/profiles.ts",
    `${header}import {DuckDBCatalog} from "../profile.js";\nimport {explicitInvocationArity} from "./invocation-policy.js";\n${duckdb.map((group, index) => `import {catalog as catalog${index}} from "./profiles/${group.version}.js";`).join("\n")}\nexport const catalogs:Readonly<Record<string,DuckDBCatalog>> = Object.freeze({${duckdb.map((group, index) => `${JSON.stringify(group.version)}:catalog${index}`).join(",")}});\nexport const emptyCatalog = new DuckDBCatalog({version:"",signatures:[],parameterNames:[],nonNullLiteralArguments:{},parameterBindings:[],implicitCasts:[],keywordInvocationForms:[],commonTypes:{},expressionTypes:{},explicitInvocationArity,tableConstantNullTyping:""});\n`,
  );
  await emit(
    "packages/duckdb/src/catalog/generated/profile-loader.ts",
    `${header}import type {DuckDBCatalog} from "../profile.js";\nconst loaders:Readonly<Record<string,()=>Promise<{readonly catalog:DuckDBCatalog}>>> = {${duckdb.map((group) => `${JSON.stringify(group.version)}:()=>import("./profiles/${group.version}.js")`).join(",")}};\nexport async function loadDuckDBCatalog(version:string):Promise<DuckDBCatalog> {if(!Object.hasOwn(loaders,version))throw new RangeError("Unsupported DuckDB analysis profile");return (await loaders[version]!()).catalog;}\n`,
  );
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
    const literalConstraints = duckdbNonNullLiteralArguments(
      routines,
      duckPolicy.literalConstraints,
      group.version,
      duckPolicy.macroSignatures,
    );
    const nonNullLiteralArguments = Object.fromEntries(
      signatures.flatMap((signature, index) => {
        const slots = literalConstraints[JSON.stringify(signature)] ?? [];
        return slots.length ? [[index, slots]] : [];
      }),
    );
    const parameterNames = signatures.map((signature) => ordered(nameGroups.get(JSON.stringify(signature))));
    const binding = duckPolicy.namedArgumentBinding[group.version];
    if (
      !binding ||
      !["version-policy", "vendor-signatures"].includes(binding.parameterModes) ||
      !["labels", "formal"].includes(binding.scalar) ||
      !["labels", "formal"].includes(binding.macro) ||
      Object.values(binding.overrides).some((mode) => !["labels", "formal"].includes(mode))
    )
      throw new TypeError(`Missing DuckDB named argument policy: ${group.version}`);
    const sourceProfile =
      binding.parameterModes === "vendor-signatures" ? sourceFacts.versions[group.version] : undefined;
    if (binding.parameterModes === "vendor-signatures" && !sourceProfile)
      throw new TypeError(`Required DuckDB vendor signature profile is missing: ${group.version}`);
    const sourceIndex = new Map();
    for (const registration of sourceProfile?.registrations ?? []) {
      const routine = sourceRoutine(registration);
      const key = duckdbBindingKey(registration.name, routine);
      sourceIndex.set(key, [...(sourceIndex.get(key) ?? []), routine]);
    }
    const bindingGroups = new Map(),
      bindingReports = [];
    for (const entity of routines) {
      const tupleKey = JSON.stringify(duckdbSemanticSignature(entity, duckPolicy.macroSignatures));
      const matches = sourceIndex.get(duckdbBindingKey(entity.name, entity.routine)) ?? [];
      const qualified = matches.map(duckdbSourceBinding);
      const alternatives = sourceProfile
        ? qualified.filter((value) => value.status === "known").map((value) => value.parameters)
        : [
            duckdbFormalNames(entity)
              .map((name) => ({ name, passing: "positional-or-named", optional: false }))
              .concat(
                entity.routine.variadic.status === "known" && entity.routine.variadic.value
                  ? [{ name: null, passing: "variadic-positional", optional: true }]
                  : [],
              ),
          ];
      bindingGroups.set(tupleKey, [...(bindingGroups.get(tupleKey) ?? []), ...alternatives]);
      bindingReports.push({
        identity: entity.identity,
        status: sourceProfile
          ? alternatives.length
            ? "vendor-signature"
            : "unqualified"
          : "capture-and-version-policy",
        reasons: sourceProfile
          ? matches.length
            ? qualified.filter((value) => value.status !== "known").map((value) => value.reason)
            : ["no-source-overload-match"]
          : ["vendor-passing-modes-not-extracted"],
      });
    }
    const parameterBindings = signatures.map((signature) => ordered(bindingGroups.get(JSON.stringify(signature))));
    const parameterBindingsLiteral = `[\n${parameterBindings.map((row) => `  (${literal(row)} satisfies BindingAlternatives) as BindingAlternatives,`).join("\n")}\n]`;
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
      parameterBindings: {
        sourceProfile: sourceProfile?.profile ?? null,
        sourceId: sourceProfile?.sourceId ?? null,
        routines: ordered(bindingReports),
      },
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
    const revision = hash({
      signatures,
      casts,
      parameterNames,
      binding,
      keywordInvocationForms,
      nonNullLiteralArguments,
      parameterBindings,
    });
    await emit(
      `packages/duckdb/src/catalog/generated/${group.version}.ts`,
      `${header}// Captured facts ${revision}\nimport type { DuckDBBuiltinSignature, DuckDBFormalParameter } from "../types.js";\ntype BindingAlternatives = readonly (readonly DuckDBFormalParameter[])[];\nexport const signatures: readonly DuckDBBuiltinSignature[] = ${rowsLiteral(signatures)};\nexport const implicitCasts: readonly (readonly [string, string])[] = ${rowsLiteral(casts)};\nexport const parameterNames: readonly (readonly (readonly (string | null)[])[])[] = ${rowsLiteral(parameterNames)};\nexport const parameterBindings: readonly BindingAlternatives[] = ${parameterBindingsLiteral};\nexport const namedArgumentBinding = ${literal(binding)} as const;\nexport const keywordInvocationForms: readonly string[] = ${literal(keywordInvocationForms)};\nexport const nonNullLiteralArguments: Readonly<Record<number, readonly number[]>> = ${literal(nonNullLiteralArguments)};\n`,
    );
  }
  await emit("planning/grammar-completeness/duckdb-routine-projection.json", `${serialize(routineProjections)}\n`);
  await emit(
    "packages/duckdb/src/catalog/generated/aliases.ts",
    `${header}export const nativeTypeAliases: Readonly<Record<string, string>> = ${literal(Object.fromEntries(Object.entries(duckAliases).sort(([a], [b]) => a.localeCompare(b))))};\n`,
  );
}
