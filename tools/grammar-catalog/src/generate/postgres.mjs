import { commonEntities } from "../model/projection.mjs";
import { checkLockedFacts } from "../provenance/source-lock.mjs";
import { sourceCoverage } from "../sources/postgres/coverage.mjs";
import {
  extractorId,
  extractorRevision,
  validateSourceFacts,
  validateSourceVersion,
} from "../sources/postgres/facts.mjs";
import { literal, ordered, parserVocabulary, rowsLiteral } from "./common.mjs";
import { postgresSemanticSignature } from "./facts/postgres-semantic.mjs";
import { generateCore } from "./postgres-core.mjs";

export async function generateCatalog({ groups, semanticGroups, input, emit, header }) {
  const policy = await input("policy", "grammar/postgres/catalog/policy.json");
  const sourceFacts = await input("source-facts", "grammar/postgres/facts/catalog.json");
  const sourceLock = await input("source-lock", "grammar/postgres/sources.lock.json");
  validateSourceFacts(sourceFacts);
  checkLockedFacts(sourceLock, sourceFacts, validateSourceVersion);
  if (sourceLock.extractor.id !== extractorId || sourceLock.extractor.revision !== (await extractorRevision()))
    throw new TypeError("PostgreSQL source extractor differs from lock; explicitly refresh vendor facts");
  await emit(
    "planning/grammar-completeness/postgres-source-coverage.json",
    `${JSON.stringify(sourceCoverage(sourceFacts, groups, policy.parser.keywords), null, 2)}\n`,
  );
  const core = await input("core", "grammar/postgres/catalog/core.json");
  const ledger = await input("versions", "grammar/features/ledger.json");
  await generateCore({ source: core, ledger, semanticGroups, emit, header });
  if (policy.formatVersion !== 1) throw new Error("Unsupported postgres generation policy");
  await parserVocabulary(policy, emit, header, "postgres");
  for (const value of Object.values(policy.syntaxVolatility))
    if (!["immutable", "stable", "volatile", "unknown"].includes(value))
      throw new Error("Invalid syntax volatility policy");
  await emit(
    "packages/postgres/src/catalog/generated/semantics.ts",
    `${header}import type { QueryVolatility } from "@typed-sql/core";\nexport const syntaxVolatility: Readonly<Record<string, QueryVolatility>> = ${literal(policy.syntaxVolatility)};\n`,
  );
  const postgres = semanticGroups;
  const shared = ordered(
    postgres.flatMap((group) => commonEntities(group, "functions").map(postgresSemanticSignature).filter(Boolean)),
  );
  const indexes = new Map(shared.map((signature, index) => [JSON.stringify(signature), index]));
  let native = `${header}import type { PostgresNativeSignature } from "../native.js";\nconst entries: readonly PostgresNativeSignature[] = ${rowsLiteral(shared)};\nexport const nativeSignatures: Readonly<Record<number, readonly PostgresNativeSignature[]>> = {\n`;
  for (const group of postgres) {
    const signatures = ordered(commonEntities(group, "functions").map(postgresSemanticSignature).filter(Boolean));
    native += `  ${group.band}: [${signatures.map((signature) => `entries[${indexes.get(JSON.stringify(signature))}]!`).join(",")}],\n`;
  }
  native += "};\n";
  await emit("packages/postgres/src/catalog/generated/native.ts", native);
}
