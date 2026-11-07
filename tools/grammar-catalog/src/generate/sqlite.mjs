import { checkLockedFacts } from "../provenance/source-lock.mjs";
import { extractorId, extractorRevision, keywordCoverage, validateKeywordFacts } from "../sources/sqlite/keywords.mjs";
import { decodeFunctions, literal, parserVocabulary, rowsLiteral } from "./common.mjs";

export async function generateCatalog({ input, emit, header, supplemental }) {
  const policy = await input("policy", "grammar/sqlite/catalog/policy.json");
  if (policy.formatVersion !== 1) throw new Error("Unsupported sqlite generation policy");
  const sourceLock = await input("vendor-source-lock", "grammar/sqlite/sources.lock.json");
  const keywordFacts = await input("vendor-keywords", "grammar/sqlite/facts/keywords.json");
  checkLockedFacts(sourceLock, keywordFacts, validateKeywordFacts);
  if (sourceLock.extractor.id !== extractorId || sourceLock.extractor.revision !== (await extractorRevision()))
    throw new TypeError("SQLite source extractor differs from lock; explicitly refresh vendor facts");
  await emit(
    "planning/grammar-completeness/sqlite-keyword-coverage.json",
    `${JSON.stringify(keywordCoverage(keywordFacts, policy.parser.keywords), null, 2)}\n`,
  );
  let strictTypes = supplemental.strictTypes;
  if (!strictTypes) {
    const ledger = await input("versions", "grammar/features/ledger.json");
    const version = ledger.dialects.sqlite.stable.at(-1)?.maximum;
    if (!version) throw new TypeError("Missing declared SQLite reference version");
    const reference = await input("strict-reference", `test/fixtures/language-audit/sqlite-reference-${version}.json`);
    strictTypes = reference.categories?.types?.rows;
  }
  await parserVocabulary(policy, emit, header, "sqlite");
  let source = `${header}import type { SqliteBuiltinDefinition, SqliteTableFunctionDefinition } from "../functions.js";\nimport type { SqliteOperatorDefinition } from "../operators.js";\n`;
  for (const [family, rows] of Object.entries(policy.functions))
    source += `export const ${family}Functions: readonly SqliteBuiltinDefinition[] = Object.freeze(${rowsLiteral(decodeFunctions(rows))});\n`;
  for (const [family, rows] of Object.entries(policy.tableFunctions)) {
    for (const row of rows) {
      if (
        !row.availableSince ||
        !/^[A-Z_][A-Z_0-9]*$/u.test(row.name) ||
        !["carray", "json", "jsonb"].includes(row.result)
      )
        throw new Error(`Invalid table-function policy: ${row.name}`);
    }
    source += `export const ${family}TableFunctions: readonly SqliteTableFunctionDefinition[] = Object.freeze(${rowsLiteral(rows)});\n`;
  }
  source += `export const operators: readonly SqliteOperatorDefinition[] = Object.freeze(${rowsLiteral(policy.operators)});\n`;
  source += `export const unsupportedOperators = ${rowsLiteral(policy.unsupportedOperators)} as const;\n`;
  source += `export const currentTimeKeywords = ${rowsLiteral(policy.currentTimeKeywords)} as const;\n`;
  await emit("packages/sqlite/src/catalog/generated/policy.ts", source);
  if (!strictTypes?.length) throw new Error("Missing independent SQLite STRICT type inventory");
  const strict = {};
  for (const row of strictTypes) {
    const mapping = policy.strictTypes[row.name];
    if (!["integer", "number", "string", "bytes", "flexible"].includes(mapping))
      throw new Error(`Missing SQLite STRICT decoding policy: ${row.name}`);
    strict[row.name] = mapping;
  }
  if (Object.keys(policy.strictTypes).some((name) => !Object.hasOwn(strict, name)))
    throw new Error("SQLite STRICT type policy refers to a name absent from the upstream inventory");
  await emit(
    "packages/sqlite/src/catalog/generated/types.ts",
    `${header}import type { SqliteAffinity } from "../coercions.js";\nexport const strictTypeMappings: Readonly<Record<string, "integer" | "number" | "string" | "bytes" | "flexible">> = ${literal(strict)};\nexport const affinityRules: readonly { readonly affinity: SqliteAffinity; readonly contains: readonly string[]; readonly empty?: boolean }[] = ${rowsLiteral(policy.affinityRules)};\nexport const defaultAffinity: SqliteAffinity = ${literal(policy.defaultAffinity)};\nexport const numericTypeNames: readonly string[] = ${rowsLiteral(policy.numericTypeNames)};\n`,
  );
}
