import { literal, ordered, parserVocabulary, rowsLiteral } from "./common.mjs";
import { postgresSignature } from "./facts/postgres.mjs";
import { generateCore } from "./postgres-core.mjs";

export async function generateCatalog({ groups, input, emit, header }) {
  const policy = await input("policy", "grammar/postgres/catalog/policy.json");
  const core = await input("core", "grammar/postgres/catalog/core.json");
  const ledger = await input("versions", "grammar/features/ledger.json");
  await generateCore({ source: core, ledger, groups, emit, header });
  if (policy.formatVersion !== 1) throw new Error("Unsupported postgres generation policy");
  await parserVocabulary(policy, emit, header, "postgres");
  for (const value of Object.values(policy.syntaxVolatility))
    if (!["immutable", "stable", "volatile", "unknown"].includes(value))
      throw new Error("Invalid syntax volatility policy");
  await emit(
    "packages/postgres/src/catalog/generated/semantics.ts",
    `${header}import type { QueryVolatility } from "@typed-sql/core";\nexport const syntaxVolatility: Readonly<Record<string, QueryVolatility>> = ${literal(policy.syntaxVolatility)};\n`,
  );
  const postgres = groups;
  const shared = ordered(
    postgres.flatMap((group) => group.categories.functions.rows.map(postgresSignature).filter(Boolean)),
  );
  const indexes = new Map(shared.map((signature, index) => [JSON.stringify(signature), index]));
  let native = `${header}import type { PostgresNativeSignature } from "../native.js";\nconst entries: readonly PostgresNativeSignature[] = ${rowsLiteral(shared)};\nexport const nativeSignatures: Readonly<Record<number, readonly PostgresNativeSignature[]>> = {\n`;
  for (const group of postgres) {
    const signatures = ordered(group.categories.functions.rows.map(postgresSignature).filter(Boolean));
    native += `  ${group.version}: [${signatures.map((signature) => `entries[${indexes.get(JSON.stringify(signature))}]!`).join(",")}],\n`;
  }
  native += "};\n";
  await emit("packages/postgres/src/catalog/generated/native.ts", native);
}
