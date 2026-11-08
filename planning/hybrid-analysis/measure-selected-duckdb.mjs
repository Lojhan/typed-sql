import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectedMeasurement } from "./selected-measurement.mjs";

const measurement = selectedMeasurement(import.meta.url);
const { read, hash, gitSource, transformSync } = measurement;
const ledger = JSON.parse(read(resolve("grammar/features/ledger.json")));
const versions = [...ledger.dialects.duckdb.stable, ...ledger.dialects.duckdb.canary].map(({ minimum, maximum }) => {
  if (minimum !== maximum) throw Error("Expected exact DuckDB versions");
  return minimum;
});
const baselineRevision = "01f17bad743762d9ae58a190670a2f234b280a3a";
const parity = [];
for (const version of versions) {
  for (const name of [version, `common-${version}`]) {
    const path = `packages/duckdb/src/catalog/generated/${name}.ts`;
    // Execute only trusted generated data modules from the pinned repository revision.
    const source = gitSource(baselineRevision, path),
      code = transformSync(source.toString(), { loader: "ts", format: "esm" }).code;
    const before = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const after = await import(pathToFileURL(resolve(path)).href);
    const baselineDigest = hash(JSON.stringify(before)),
      currentDigest = hash(JSON.stringify(after));
    if (baselineDigest !== currentDigest) throw Error(`DuckDB catalog parity differs for ${name}`);
    parity.push({
      version,
      profile: name,
      signatures: after.signatures?.length,
      sourceDigest: hash(source),
      baselineDigest,
      currentDigest,
    });
  }
}
const scenarios = {
  runtimeRoot: 'export {sql,renderer,defineQueryValuePlan,withQueryValuePlan} from "@typed-sql/duckdb";',
  compatibility: 'export {duckdb} from "@typed-sql/duckdb/analysis";',
};
for (const version of versions)
  scenarios[`selected${version}`] = `export {duckdb} from "@typed-sql/duckdb/analysis/profiles/${version}";`;
const rows = [];
for (const [scenario, contents] of Object.entries(scenarios)) {
  const row = await measurement.bundle(scenario, contents);
  const nativeProfiles = [],
    typeProfiles = [];
  for (const { path } of row.catalogInputs) {
    const native = /catalog\/generated\/(\d+\.\d+\.\d+)\.ts$/u.exec(path);
    if (native) nativeProfiles.push(native[1]);
    const common = /catalog\/generated\/common-(\d+\.\d+\.\d+)\.ts$/u.exec(path);
    if (common) typeProfiles.push(common[1]);
    if (scenario.startsWith("selected") && /catalog\/generated\/(?:registry|profiles)\.ts$/u.test(path))
      throw Error(`Eager registry in selected graph: ${path}`);
  }
  if (scenario.startsWith("selected")) {
    const version = scenario.slice("selected".length);
    if (
      nativeProfiles.length !== 1 ||
      nativeProfiles[0] !== version ||
      typeProfiles.length !== 1 ||
      typeProfiles[0] !== version
    )
      throw Error(`Unrelated catalog profiles in ${scenario}`);
  }
  rows.push({ ...row, nativeProfiles, typeProfiles });
}
measurement.finish(
  "artifacts/grammar-catalog/duckdb-selected-bundles.json",
  {
    baselineRevision,
    parity,
    scope:
      "Exported analyzer factory footprint; selected factories retain exactly one native signature/parameter/cast profile and one common-type profile. Not an application workload, installation-size reduction, compact-core claim or complete engine inventory.",
  },
  rows,
);
