import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectedMeasurement } from "./selected-measurement.mjs";

const measurement = selectedMeasurement(import.meta.url);
const { read, hash, gitSource, transformSync } = measurement;
const ledger = JSON.parse(read(resolve("grammar/features/ledger.json")));
const majors = [...ledger.dialects.postgres.stable, ...ledger.dialects.postgres.canary].map(({ minimum, maximum }) => {
  if (minimum !== maximum) throw Error("Expected exact PostgreSQL majors");
  return Number(minimum);
});
// Execute only the generated data module from this pinned, trusted repository revision.
const baselineRevision = "417c1d3020b2655dc798ac220bc8de31fa3a7e08";
const baselineSource = gitSource(baselineRevision, "packages/postgres/src/catalog/generated/native.ts");
const baselineModule = transformSync(baselineSource.toString(), { loader: "ts", format: "esm" }).code;
const before = (await import(`data:text/javascript;base64,${Buffer.from(baselineModule).toString("base64")}`))
  .nativeSignatures;
const current = (await import(pathToFileURL(resolve("packages/postgres/src/catalog/generated/native.ts")).href))
  .nativeSignatures;
const parity = majors.map((major) => {
  const baselineDigest = hash(JSON.stringify(before[major])),
    currentDigest = hash(JSON.stringify(current[major]));
  if (baselineDigest !== currentDigest) throw Error(`Native signature parity differs for ${major}`);
  return {
    major,
    signatures: current[major].length,
    names: new Set(current[major].map((row) => row.name)).size,
    baselineDigest,
    currentDigest,
  };
});
const scenarios = {
  runtimeRoot: 'export {sql,renderer,defineQueryValuePlan,withQueryValuePlan} from "@typed-sql/postgres";',
  coreAll: 'export {postgres} from "@typed-sql/postgres/analysis/core";',
  compatibility: 'export {postgres} from "@typed-sql/postgres/analysis";',
};
for (const major of majors) {
  scenarios[`selected${major}`] = `export {postgres} from "@typed-sql/postgres/analysis/profiles/${major}";`;
  scenarios[`core${major}`] = `export {postgres} from "@typed-sql/postgres/analysis/core/profiles/${major}";`;
  scenarios[`packed${major}`] =
    `import {postgres as core} from "@typed-sql/postgres/analysis/core/profiles/${major}";import {compatibilityPack} from "@typed-sql/postgres/analysis/packs/compatibility/${major}";export function postgres(options={}){return core({...options,packs:[compatibilityPack]});}`;
}
const rows = [];
for (const [scenario, contents] of Object.entries(scenarios)) {
  const row = await measurement.bundle(scenario, contents);
  const { catalogInputs } = row;
  const nativeProfiles = catalogInputs
    .flatMap(({ path }) => {
      const match = /catalog\/generated\/native\/(\d+)\.ts$/u.exec(path);
      return match ? [Number(match[1])] : [];
    })
    .sort((a, b) => a - b);
  const typeProfiles = catalogInputs
    .flatMap(({ path }) => {
      const match = /catalog\/generated\/(\d+)\.ts$/u.exec(path);
      return match ? [Number(match[1])] : [];
    })
    .sort((a, b) => a - b);
  if (scenario.startsWith("selected")) {
    const major = Number(scenario.slice("selected".length));
    if (typeProfiles.length !== 1 || typeProfiles[0] !== major)
      throw new Error(`Selected profile ${major} loaded other core catalog data`);
    if (nativeProfiles.length !== 1 || nativeProfiles[0] !== major)
      throw Error(`Selected bundle includes unrelated native profiles: ${scenario}`);
  }
  const offlineProfiles = catalogInputs.flatMap(({ path }) => {
    const match = /catalog\/generated\/offline\/(\d+)\.ts$/u.exec(path);
    return match ? [Number(match[1])] : [];
  });
  const compatibilityProfiles = catalogInputs.flatMap(({ path }) => {
    const match = /catalog\/generated\/compatibility\/(\d+)\.ts$/u.exec(path);
    return match ? [Number(match[1])] : [];
  });
  if (/^core\d/u.test(scenario)) {
    const major = Number(scenario.slice(4));
    if (
      nativeProfiles.length ||
      compatibilityProfiles.length ||
      offlineProfiles.length !== 1 ||
      offlineProfiles[0] !== major ||
      typeProfiles.length !== 1 ||
      typeProfiles[0] !== major
    )
      throw Error(`Core imports full or unrelated profiles: ${scenario}`);
  }
  if (scenario === "coreAll" && (nativeProfiles.length || compatibilityProfiles.length))
    throw Error("The default core imports full catalog data");
  rows.push({ ...row, nativeProfiles, typeProfiles, offlineProfiles, compatibilityProfiles });
}
measurement.finish(
  "artifacts/grammar-catalog/postgres-selected-bundles.json",
  {
    baselineRevision,
    baselineSourceDigest: hash(baselineSource),
    scope:
      "Exported analyzer factory footprint; selected factories retain their version profiles; compact cores exclude the compatibility projection and optional packs restore that projection. Not an application workload, installation-size reduction, production-popularity coverage or complete engine inventory.",
    parity,
  },
  rows,
);
