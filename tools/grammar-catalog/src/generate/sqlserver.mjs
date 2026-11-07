import { checkLockedFacts } from "../provenance/source-lock.mjs";
import { sourceCoverage } from "../sources/sqlserver/coverage.mjs";
import { extractorId, extractorRevision, validateSourceFacts } from "../sources/sqlserver/facts.mjs";
import { decodeFunctions, rowsLiteral } from "./common.mjs";
import { sqlServerSemanticTypeSource } from "./sqlserver-types.mjs";

export async function generateCatalog({ groups, semanticGroups, input, emit, header }) {
  const facts = await input("source-facts", "grammar/sqlserver/facts/catalog.json"),
    lock = await input("source-lock", "grammar/sqlserver/sources.lock.json");
  checkLockedFacts(lock, facts, validateSourceFacts);
  if (lock.extractor.id !== extractorId || lock.extractor.revision !== (await extractorRevision()))
    throw new TypeError("ScriptDOM extractor differs from lock; explicitly refresh source facts");
  await emit(
    "planning/grammar-completeness/sqlserver-source-coverage.json",
    `${JSON.stringify(sourceCoverage(facts, groups), null, 2)}\n`,
  );
  const policy = await input("policy", "grammar/sqlserver/catalog/policy.json");
  if (policy.formatVersion !== 1) throw new Error("Unsupported sqlserver generation policy");
  const entries = decodeFunctions(policy.functions, {
    bounds: (row) => [row.minimumArguments, row.maximumArguments],
    withBounds: (row, bounds) => ({ ...row, maximumArguments: bounds[1] }),
  });
  for (const entry of entries) {
    if (
      entry.resultType !== undefined &&
      !policy.types.some((type) => type.name === entry.resultType && type.form === "plain")
    )
      throw new Error(`Missing plain SQL Server result type policy: ${entry.name}`);
    if (entry.intrinsicNullable !== undefined && typeof entry.intrinsicNullable !== "boolean")
      throw new Error(`Invalid intrinsic nullability policy: ${entry.name}`);
  }
  await emit(
    "packages/sqlserver/src/catalog/generated/types.ts",
    sqlServerSemanticTypeSource(policy, semanticGroups, header),
  );
  await emit(
    "packages/sqlserver/src/catalog/generated/policy.ts",
    `${header}import type { SqlServerBuiltin } from "../index.js";\nexport const builtinEntries: readonly SqlServerBuiltin[] = Object.freeze(${rowsLiteral(entries)});\nexport const dateparts = ${rowsLiteral(policy.dateparts)} as const;\n`,
  );
}
