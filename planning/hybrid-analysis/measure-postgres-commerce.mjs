import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { postgres } from "../../packages/postgres/src/analysis/core/18.ts";
import { pg } from "../../packages/postgres/src/pg.ts";
import { createPgNativeContractAdapter } from "../../packages/postgres/src/pg-contracts.ts";
import { postgresProfile } from "../../packages/postgres/src/profile.ts";
import { createPostgresContractReconciler } from "../../packages/postgres/src/reconciliation.ts";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.ts";
import { measureNativeProject } from "./measure-native-project.mjs";

assert.ok(process.env.TYPED_SQL_POSTGRES_URL, "Set an explicit owned audit server URL");
const admin = new Pool({ connectionString: process.env.TYPED_SQL_POSTGRES_URL, max: 1 });
const name = `typed_sql_commerce_${randomBytes(8).toString("hex")}`;
const target = new URL(process.env.TYPED_SQL_POSTGRES_URL);
target.pathname = `/${name}`;
let created = false,
  pool;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  pool = new Pool({ connectionString: target.href, max: 2 });
  const files = commerceFiles("postgres");
  for (const [file, source] of Object.entries(files))
    if (file.startsWith("schema/") && file.endsWith(".sql")) await pool.query(source);
  const schema = await pg({ connectionString: target.href, schemas: ["public"] }).introspect();
  assert.match(schema.server.version, /^18\./u);
  const profile = postgresProfile(),
    core = postgres(),
    contribution = createPostgresContractReconciler();
  const report = await measureNativeProject({
    label: `postgres-commerce-${schema.server.version}`,
    fixtureProducer: import.meta.url,
    schema,
    profile,
    files,
    analyze: (sql) => core.analyze(sql, schema),
    adapter: createPgNativeContractAdapter({ pool, schema }),
    contribution,
    policy: {
      mode: "native-required",
      owner: { id: contribution.id, version: contribution.version },
      requiredNativeFacets: ["runtime-type"],
    },
    ...(process.argv[3] ? { scales: process.argv[3].split(",").map(Number) } : {}),
    async beforeOffline() {
      await pool.end();
      pool = undefined;
      await admin.query(`DROP DATABASE "${name}"`);
      created = false;
    },
  });
  report.fixture = { tables: Object.keys(schema.tables).length, ownedDatabaseRemovedBeforeOffline: !created };
  await writeFile(
    resolve(process.argv[2] ?? "planning/hybrid-analysis/postgres-native-project.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      label: report.label,
      acquisitions: report.acquisitions,
      offlineNativeCalls: report.offlineNativeCalls,
    }),
  );
} finally {
  await pool?.end();
  try {
    if (created) await admin.query(`DROP DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
