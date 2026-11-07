import { parserVocabulary } from "./common.mjs";
import { generateCore } from "./mysql-core.mjs";

export async function generateCatalog({ groups, input, emit, header }) {
  const policy = await input("policy", "grammar/mysql/catalog/policy.json");
  const core = await input("core", "grammar/mysql/catalog/core.json");
  const ledger = await input("versions", "grammar/features/ledger.json");
  await generateCore({ source: core, ledger, groups, emit, header });
  if (policy.formatVersion !== 1) throw new Error("Unsupported mysql generation policy");
  await parserVocabulary(policy, emit, header, "mysql");
}
