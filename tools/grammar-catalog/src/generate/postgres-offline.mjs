import { hash } from "../model/canonical.mjs";
import { ordered } from "./common.mjs";
import { emitPostgresProfiles } from "./postgres-profiles.mjs";

/** Project reviewed name policy onto complete pinned overload families. No host-code discovery. */
export async function generatePostgresOffline({ sourceSignatures, core, input, emit, header }) {
  const policy = await input("offline-core", "grammar/postgres/catalog/offline-core.json");
  if (
    policy.formatVersion !== 1 ||
    !Number.isSafeInteger(policy.nameBudget) ||
    policy.nameBudget < 1 ||
    !Array.isArray(policy.names) ||
    policy.names.length > policy.nameBudget ||
    new Set(policy.names).size !== policy.names.length ||
    policy.names.some((name) => typeof name !== "string" || !/^[_a-z][_a-z0-9]*$/u.test(name))
  )
    throw new TypeError("Invalid PostgreSQL offline-core selection policy");
  if (
    policy.selection?.kind !== "semantic-families-and-synthetic-application-workloads" ||
    policy.selection.license !== "MIT" ||
    !Array.isArray(policy.workloads) ||
    !policy.workloads.length ||
    policy.workloads.some(
      (workload) => typeof workload.scenario !== "string" || typeof workload.sql !== "string" || !workload.sql,
    )
  )
    throw new TypeError("Missing PostgreSQL offline workload provenance");
  const known = new Set(
    [...sourceSignatures.values()]
      .flat()
      .filter((row) => row.namespace === "pg_catalog")
      .map((row) => row.name),
  );
  for (const name of policy.names)
    if (!known.has(name)) throw new TypeError(`Offline policy selects an absent PostgreSQL routine: ${name}`);
  const names = new Set(policy.names),
    profiles = [],
    coreProfiles = new Map(),
    compatibilityProfiles = new Map(),
    coreDigests = new Map();
  for (const [major, all] of sourceSignatures) {
    const signatures = ordered(all.filter((row) => row.namespace === "pg_catalog" && names.has(row.name)));
    const sourceDigest = hash(all),
      coreDigest = hash(signatures);
    const counts = {
      nativeNames: new Set(signatures.map((row) => row.name)).size,
      nativeSignatures: signatures.length,
      compatibilityNames: new Set(all.map((row) => row.name)).size,
      compatibilitySignatures: all.length,
    };
    profiles.push({ major, sourceDigest, coreDigest, ...counts });
    coreProfiles.set(major, signatures);
    compatibilityProfiles.set(
      major,
      ordered(all.filter((row) => row.namespace !== "pg_catalog" || !names.has(row.name))),
    );
    coreDigests.set(major, coreDigest);
    await emit(
      `packages/postgres/src/analysis/core/generated/${major}.ts`,
      `${header}import {createPostgresCoreAnalyzer,type PostgresCoreOptions} from "../factory.js";\nimport catalog from "../../../catalog/generated/${major}.js";\nimport {nativeSignatures,coreDigest} from "../../../catalog/generated/offline/${major}.js";\nexport type {PostgresCoreOptions} from "../factory.js";\nexport function postgres(options:PostgresCoreOptions={}) {return createPostgresCoreAnalyzer(options,{${major}:nativeSignatures},()=>catalog,{${major}:coreDigest},${major});}\n`,
    );
    await emit(
      `packages/postgres/src/analysis/packs/generated/${major}.ts`,
      `${header}import {definePostgresAnalysisPack} from "../pack.js";\nimport catalog from "../../../catalog/generated/${major}.js";\nimport {nativeSignatures} from "../../../catalog/generated/compatibility/${major}.js";\nimport {POSTGRES_DIALECT_VERSION} from "../../../version.js";\nexport const compatibilityPack=definePostgresAnalysisPack({formatVersion:1,id:"postgres/compatibility/${major}",grammar:"postgres",major:${major},grammarVersion:POSTGRES_DIALECT_VERSION,catalogRevision:catalog.revision,sourceDigest:${JSON.stringify(sourceDigest)},facets:["projected-routine-signatures","projected-volatility","projected-null-input-behavior"],dependencies:[{id:"postgres/core/${major}",digest:${JSON.stringify(coreDigest)}}],signatures:nativeSignatures});\n`,
    );
  }
  const coreLocations = await emitPostgresProfiles({
    profiles: coreProfiles,
    directory: "offline",
    emit,
    header,
    extraExports: new Map(
      [...coreDigests].map(([major, digest]) => [major, `export const coreDigest = ${JSON.stringify(digest)};\n`]),
    ),
  });
  const compatibilityLocations = await emitPostgresProfiles({
    profiles: compatibilityProfiles,
    directory: "compatibility",
    emit,
    header,
  });
  const majors = [...sourceSignatures.keys()];
  await emit(
    "packages/postgres/src/catalog/generated/offline.ts",
    `${header}import type {PostgresNativeCatalog} from "../native-resolution.js";\n${majors.map((major) => `import {nativeSignatures as native${major}} from "./offline/${major}.js";`).join("\n")}\nexport const nativeSignatures:PostgresNativeCatalog=Object.freeze({${majors.map((major) => `${major}:native${major}`).join(",")}});\nexport const coreDigests:Readonly<Record<number,string>> = Object.freeze(${JSON.stringify(Object.fromEntries(coreDigests))});\n`,
  );
  const families = core.routines.flatMap((family) => family.routines);
  await emit(
    "planning/grammar-completeness/postgres-offline-selection.json",
    `${JSON.stringify({ formatVersion: 1, selection: policy.selection, policyDigest: hash(policy), nameBudget: policy.nameBudget, selectedNames: policy.names, maintainedRoutineFamilies: core.routines.length, maintainedRoutineFamilyNames: [...new Set(families)].sort(), profiles }, null, 2)}\n`,
  );
  return { coreLocations, compatibilityLocations };
}
