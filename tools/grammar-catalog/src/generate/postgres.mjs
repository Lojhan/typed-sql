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
  // Partition by exact profile membership. A selected profile imports only groups it uses.
  const memberships = new Map();
  for (const [major, signatures] of sourceSignatures)
    for (const signature of signatures) {
      const key = JSON.stringify(signature);
      const entry = memberships.get(key) ?? { signature, majors: [] };
      entry.majors.push(major);
      memberships.set(key, entry);
    }
  const partitions = new Map();
  for (const { signature, majors } of memberships.values()) {
    const name = majors
      .map(Number)
      .sort((a, b) => a - b)
      .join("-");
    const rows = partitions.get(name) ?? [];
    rows.push(signature);
    partitions.set(name, rows);
  }
  const locations = new Map();
  for (const [name, values] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
    const signatures = ordered(values);
    signatures.forEach((signature, index) => {
      locations.set(JSON.stringify(signature), { name, index });
    });
    await emit(
      `packages/postgres/src/catalog/generated/native/groups/${name}.ts`,
      `${header}import type { PostgresNativeSignature } from "../../../native-resolution.js";\nexport const entries: readonly PostgresNativeSignature[] = ${rowsLiteral(signatures)};\n`,
    );
  }
  for (const [major, signatures] of sourceSignatures) {
    const groups = [...new Set(signatures.map((signature) => locations.get(JSON.stringify(signature)).name))].sort();
    const aliases = new Map(groups.map((name, index) => [name, `group${index}`]));
    await emit(
      `packages/postgres/src/catalog/generated/native/${major}.ts`,
      `${header}import type { PostgresNativeSignature } from "../../native-resolution.js";\n${groups.map((name) => `import {entries as ${aliases.get(name)}} from "./groups/${name}.js";`).join("\n")}\nexport const nativeSignatures: readonly PostgresNativeSignature[] = Object.freeze([${signatures
        .map((signature) => {
          const { name, index } = locations.get(JSON.stringify(signature));
          return `${aliases.get(name)}[${index}]!`;
        })
        .join(",")}]);\n`,
    );
  }
  for (const major of sourceSignatures.keys()) {
    await emit(
      `packages/postgres/src/analysis/generated/${major}.ts`,
      `${header}import {createPostgresAnalyzer} from "../../analysis-factory.js";\nimport type {PostgresDialectOptions} from "../../analysis-options.js";\nimport {nativeSignatures} from "../../catalog/generated/native/${major}.js";\nexport type {PostgresDialectOptions} from "../../analysis-options.js";\nexport function postgres(options:PostgresDialectOptions={}) {return createPostgresAnalyzer(options,Object.freeze({${major}:nativeSignatures}),${major});}\n`,
    );
  }
  const majors = [...sourceSignatures.keys()];
  await emit(
    "packages/postgres/src/catalog/generated/native.ts",
    `${header}import type { PostgresNativeCatalog } from "../native-resolution.js";\n${majors.map((major) => `import {nativeSignatures as native${major}} from "./native/${major}.js";`).join("\n")}\nexport const nativeSignatures: PostgresNativeCatalog = Object.freeze({${majors.map((major) => `${major}:native${major}`).join(",")}});\n`,
  );
  await emit(
    "packages/postgres/src/catalog/generated/native-loader.ts",
    `${header}import type { PostgresNativeSignature } from "../native-resolution.js";\nconst loaders: Readonly<Record<number,()=>Promise<{readonly nativeSignatures:readonly PostgresNativeSignature[]}>>> = {${majors.map((major) => `${major}:()=>import("./native/${major}.js")`).join(",")}};\nexport async function loadPostgresNativeSignatures(major:number):Promise<readonly PostgresNativeSignature[]> {if(!Number.isSafeInteger(major)||!Object.hasOwn(loaders,major))throw new RangeError("Unsupported PostgreSQL native-signature profile");return (await loaders[major]!()).nativeSignatures;}\n`,
  );
}
