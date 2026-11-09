import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqlite } from "../../packages/sqlite/src/analysis/core.ts";
import { nodeSqlite } from "../../packages/sqlite/src/node-sqlite.ts";
import { createNodeSqliteNativeContractAdapter } from "../../packages/sqlite/src/node-sqlite-contracts.ts";
import { sqliteProfile } from "../../packages/sqlite/src/profile.ts";
import { createSqliteContractReconciler } from "../../packages/sqlite/src/reconciliation.ts";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.ts";
import { measureNativeProject } from "./measure-native-project.mjs";

const directory = await mkdtemp(join(tmpdir(), "typed-sql-commerce-sqlite-"));
const path = join(directory, "commerce.sqlite");
const database = new DatabaseSync(path);
let closed = false;
try {
  const files = commerceFiles("sqlite");
  for (const [file, source] of Object.entries(files))
    if (file.startsWith("schema/") && file.endsWith(".sql")) database.exec(source);
  const schema = await nodeSqlite({ database }).introspect();
  const profile = sqliteProfile(),
    core = sqlite(),
    contribution = createSqliteContractReconciler();
  const report = await measureNativeProject({
    label: `sqlite-commerce-${schema.server.version}`,
    fixtureProducer: import.meta.url,
    schema,
    profile,
    files,
    analyze: (sql) => core.analyze(sql, schema),
    adapter: createNodeSqliteNativeContractAdapter({ path, schema }),
    contribution,
    policy: {
      mode: "native-required",
      owner: { id: contribution.id, version: contribution.version },
      requiredNativeFacets: ["runtime-type"],
    },
    ...(process.argv[3] ? { scales: process.argv[3].split(",").map(Number) } : {}),
    async beforeOffline() {
      database.close();
      closed = true;
      await rm(path);
    },
  });
  const destination = resolve(process.argv[2] ?? "planning/hybrid-analysis/sqlite-native-project.json");
  report.fixture = {
    tables: Object.keys(schema.tables).length,
    ownedDatabaseRemovedBeforeOffline: closed,
  };
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  assert.ok(
    report.observations.every((observation) => observation.admittedSubsetComplete),
    "Every admitted commerce read must qualify",
  );
  console.log(
    JSON.stringify({
      label: report.label,
      observations: report.observations.map(
        ({ copies, finiteCandidates, admitted, qualified, completeProject, durable, cache }) => ({
          copies,
          finiteCandidates,
          admitted,
          qualified,
          completeProject,
          durable,
          cache,
        }),
      ),
      offlineNativeCalls: report.offlineNativeCalls,
    }),
  );
} finally {
  if (!closed) database.close();
  await rm(directory, { recursive: true, force: true });
}
