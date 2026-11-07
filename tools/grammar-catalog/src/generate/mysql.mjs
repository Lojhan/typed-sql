import { checkLockedFacts } from "../provenance/source-lock.mjs";
import { sourceCoverage } from "../sources/mysql/coverage.mjs";
import { extractorId, extractorRevision, validateSourceFacts } from "../sources/mysql/facts.mjs";
import { parserVocabulary } from "./common.mjs";
import { generateCore } from "./mysql-core.mjs";

export async function generateCatalog({ groups, input, emit, header }) {
  const policy = await input("policy", "grammar/mysql/catalog/policy.json");
  const facts = await input("source-facts", "grammar/mysql/facts/catalog.json");
  const lock = await input("source-lock", "grammar/mysql/sources.lock.json");
  checkLockedFacts(lock, facts, validateSourceFacts);
  if (lock.extractor.id !== extractorId || lock.extractor.revision !== (await extractorRevision()))
    throw new TypeError("MySQL source extractor differs from lock; explicitly refresh vendor facts");
  await emit(
    "planning/grammar-completeness/mysql-source-coverage.json",
    `${JSON.stringify(sourceCoverage(facts, groups), null, 2)}\n`,
  );
  const core = await input("core", "grammar/mysql/catalog/core.json");
  const ledger = await input("versions", "grammar/features/ledger.json");
  await generateCore({ source: core, facts, ledger, groups, emit, header });
  if (policy.formatVersion !== 1) throw new Error("Unsupported mysql generation policy");
  await parserVocabulary(policy, emit, header, "mysql");
}
