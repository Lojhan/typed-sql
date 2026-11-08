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
import { literal, ordered, parserVocabulary } from "./common.mjs";
import { postgresSemanticSignature } from "./facts/postgres-semantic.mjs";
import { generateCore } from "./postgres-core.mjs";
import { generatePostgresOffline } from "./postgres-offline.mjs";

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
  const { coreLocations, compatibilityLocations } = await generatePostgresOffline({
    sourceSignatures,
    core,
    input,
    emit,
    header,
  });
  for (const [major, signatures] of sourceSignatures) {
    const location = (row) => {
      const key = JSON.stringify(row),
        core = coreLocations.get(key),
        value = core ?? compatibilityLocations.get(key);
      if (!value) throw new TypeError("Missing PostgreSQL offline partition row");
      return { directory: core === undefined ? "compatibility" : "offline", ...value };
    };
    const groups = [
      ...new Set(
        signatures.map((row) => {
          const value = location(row);
          return `${value.directory}/groups/${value.name}`;
        }),
      ),
    ].sort();
    const aliases = new Map(groups.map((group, index) => [group, `group${index}`]));
    await emit(
      `packages/postgres/src/catalog/generated/native/${major}.ts`,
      `${header}import type {PostgresNativeSignature} from "../../native-resolution.js";\n${groups.map((group) => `import {entries as ${aliases.get(group)}} from "../${group}.js";`).join("\n")}\nexport const nativeSignatures:readonly PostgresNativeSignature[] = Object.freeze([${signatures
        .map((row) => {
          const value = location(row);
          return `${aliases.get(`${value.directory}/groups/${value.name}`)}[${value.index}]!`;
        })
        .join(",")}]);\n`,
    );
  }
  for (const major of sourceSignatures.keys()) {
    await emit(
      `packages/postgres/src/analysis/generated/${major}.ts`,
      `${header}import {createPostgresAnalyzer} from "../../analysis-factory.js";\nimport type {PostgresDialectOptions} from "../../analysis-options.js";\nimport {nativeSignatures} from "../../catalog/generated/native/${major}.js";\nexport type {PostgresDialectOptions} from "../../analysis-options.js";\nimport catalog from "../../catalog/generated/${major}.js";\nexport function postgres(options:PostgresDialectOptions={}) {return createPostgresAnalyzer(options,Object.freeze({${major}:nativeSignatures}),()=>catalog,${major});}\n`,
    );
  }
  const majors = [...sourceSignatures.keys()];
  await emit(
    "packages/postgres/src/catalog/generated/native.ts",
    `${header}import type { PostgresNativeCatalog } from "../native-resolution.js";\n${majors.map((major) => `import {nativeSignatures as native${major}} from "./native/${major}.js";`).join("\n")}\nexport const nativeSignatures: PostgresNativeCatalog = Object.freeze({${majors.map((major) => `${major}:native${major}`).join(",")}});\n`,
  );
  await emit(
    "packages/postgres/src/catalog/generated/core-loader.ts",
    `${header}import type { PostgresCoreCatalog } from "../types.js";\nconst loaders: Readonly<Record<number,()=>Promise<{readonly default:PostgresCoreCatalog}>>> = {${majors.map((major) => `${major}:()=>import("./${major}.js")`).join(",")}};\nexport async function loadPostgresCoreCatalog(major:number):Promise<PostgresCoreCatalog> {if(!Number.isSafeInteger(major)||!Object.hasOwn(loaders,major))throw new RangeError("Unsupported PostgreSQL core profile");return (await loaders[major]!()).default;}\n`,
  );
  await emit(
    "packages/postgres/src/catalog/generated/native-loader.ts",
    `${header}import type { PostgresNativeSignature } from "../native-resolution.js";\nconst loaders: Readonly<Record<number,()=>Promise<{readonly nativeSignatures:readonly PostgresNativeSignature[]}>>> = {${majors.map((major) => `${major}:()=>import("./native/${major}.js")`).join(",")}};\nexport async function loadPostgresNativeSignatures(major:number):Promise<readonly PostgresNativeSignature[]> {if(!Number.isSafeInteger(major)||!Object.hasOwn(loaders,major))throw new RangeError("Unsupported PostgreSQL native-signature profile");return (await loaders[major]!()).nativeSignatures;}\n`,
  );
}
