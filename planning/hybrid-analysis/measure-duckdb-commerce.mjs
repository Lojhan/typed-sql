import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeDuckDB } from "../../packages/duckdb/src/node-api.ts";
import { createNodeDuckDBNativeContractAdapter } from "../../packages/duckdb/src/node-api-contracts.ts";
import { duckdbProfile } from "../../packages/duckdb/src/profile.ts";
import { createDuckDBContractReconciler } from "../../packages/duckdb/src/reconciliation.ts";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.ts";
import { measureNativeProject } from "./measure-native-project.mjs";

// Each invocation loads exactly one SDK; native SDK versions must run in separate processes.
const sdkName = process.env.TYPED_SQL_DUCKDB_SDK_PACKAGE ?? "@duckdb/node-api";
if (!["@duckdb/node-api", "duckdb-node-15"].includes(sdkName)) throw Error("Unreviewed DuckDB SDK");
const sdk = await import(
  pathToFileURL(createRequire(new URL("../../packages/duckdb/package.json", import.meta.url)).resolve(sdkName)).href
);
const version = sdk.version().replace(/^v/u, "");
if (!["1.5.6", "2.0.0"].includes(version)) throw Error("Unqualified DuckDB version");
const { duckdb } = await import(`../../packages/duckdb/src/analysis/core/${version}.ts`);
const directory = await mkdtemp(join(tmpdir(), "typed-sql-commerce-duckdb-"));
const path = join(directory, "commerce.duckdb");
try {
  const files = commerceFiles("duckdb");
  const instance = await sdk.DuckDBInstance.create(path);
  const connection = await instance.connect();
  try {
    for (const [file, source] of Object.entries(files))
      if (file.startsWith("schema/") && file.endsWith(".sql")) await connection.run(source);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  const sdkImporter = async () => sdk;
  const schema = await nodeDuckDB({ path, sdkImporter }).introspect();
  const profile = duckdbProfile(),
    core = duckdb(),
    contribution = createDuckDBContractReconciler();
  const report = await measureNativeProject({
    label: `duckdb-commerce-${version}`,
    fixtureProducer: import.meta.url,
    schema,
    profile,
    files,
    analyze: (sql) => core.analyze(sql, schema),
    adapter: createNodeDuckDBNativeContractAdapter({ path, schema, sdkImporter }),
    contribution,
    policy: {
      mode: "native-required",
      owner: { id: contribution.id, version: contribution.version },
      requiredNativeFacets: ["runtime-type"],
    },
    ...(process.argv[3] ? { scales: process.argv[3].split(",").map(Number) } : {}),
    async beforeOffline() {
      await rm(path);
    },
  });
  report.fixture = { tables: Object.keys(schema.tables).length, ownedDatabaseRemovedBeforeOffline: true };
  await writeFile(
    resolve(process.argv[2] ?? `planning/hybrid-analysis/duckdb-${version}-native-project.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      label: report.label,
      observations: report.observations,
      offlineNativeCalls: report.offlineNativeCalls,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
