import { commonEntities } from "../model/projection.mjs";
import { checkLockedFacts } from "../provenance/source-lock.mjs";
import { sourceCoverage } from "../sources/postgres/coverage.mjs";
import {
  checkSourceTexts,
  extractorId,
  extractorRevision,
  validateSourceFacts,
  validateSourceVersion,
} from "../sources/postgres/facts.mjs";
import { prepareSourceProfile } from "../sources/postgres/model.mjs";
import { literal, ordered, parserVocabulary, rowsLiteral } from "./common.mjs";
import { postgresSemanticSignature } from "./facts/postgres-semantic.mjs";
import { generateCore } from "./postgres-core.mjs";

export async function generateCatalog({ groups, semanticGroups, input, emit, header }) {
  const policy = await input("policy", "grammar/postgres/catalog/policy.json");
  const sourceFacts = await input("source-facts", "grammar/postgres/facts/catalog.json");
  const sourceLock = await input("source-lock", "grammar/postgres/sources.lock.json");
  validateSourceFacts(sourceFacts);
  checkLockedFacts(sourceLock, sourceFacts, validateSourceVersion);
  checkSourceTexts(sourceLock, sourceFacts);
  if (sourceLock.extractor.id !== extractorId || sourceLock.extractor.revision !== (await extractorRevision()))
    throw new TypeError("PostgreSQL source extractor differs from lock; explicitly refresh vendor facts");
  const prepared = new Map();
  for (const group of groups)
    for (const { id, capture } of group.contexts) {
      const version = /^(\d+(?:\.\d+|beta\d+))/u.exec(capture.target.version)?.[1];
      const source = sourceFacts.versions[version];
      if (!source) throw new TypeError(`Missing PostgreSQL source profile: ${capture.target.version}`);
      prepared.set(id, prepareSourceProfile(sourceFacts, source, capture));
    }
  await emit(
    "planning/grammar-completeness/postgres-source-coverage.json",
    `${JSON.stringify(sourceCoverage(sourceFacts, groups, policy.parser.keywords, prepared), null, 2)}\n`,
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
  const sourceSignatures = new Map(
    postgres.map((group) => {
      const contexts = groups.find((native) => native.version === group.band)?.contexts;
      if (!contexts?.length) throw new TypeError("Missing PostgreSQL source projection contexts");
      const signatures = commonEntities(group, "functions")
        .map((entity) => {
          const candidates = contexts.map(({ id }) => prepared.get(id).routines.get(entity.routine.identity));
          if (candidates.some((routine) => routine === undefined))
            throw new TypeError("Incomplete PostgreSQL source projection across profiles");
          const values = candidates.map((routine) => postgresSemanticSignature({ ...entity, routine }));
          if (new Set(values.map((value) => JSON.stringify(value))).size !== 1)
            throw new TypeError("Conflicting PostgreSQL source signatures across profiles");
          return values[0];
        })
        .filter(Boolean);
      return [group.band, ordered(signatures)];
    }),
  );
  const shared = ordered([...sourceSignatures.values()].flat());
  const indexes = new Map(shared.map((signature, index) => [JSON.stringify(signature), index]));
  let native = `${header}import type { PostgresNativeSignature } from "../native.js";\nconst entries: readonly PostgresNativeSignature[] = ${rowsLiteral(shared)};\nexport const nativeSignatures: Readonly<Record<number, readonly PostgresNativeSignature[]>> = {\n`;
  for (const group of postgres) {
    const signatures = sourceSignatures.get(group.band);
    native += `  ${group.band}: [${signatures.map((signature) => `entries[${indexes.get(JSON.stringify(signature))}]!`).join(",")}],\n`;
  }
  native += "};\n";
  await emit("packages/postgres/src/catalog/generated/native.ts", native);
}
