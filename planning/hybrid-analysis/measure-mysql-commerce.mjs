import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mysql } from "../../packages/mysql/src/analysis/core/8.4.ts";
import { mysql2 } from "../../packages/mysql/src/mysql2.ts";
import { createMySql2NativeContractAdapter } from "../../packages/mysql/src/mysql2-contracts.ts";
import { mysqlProfile } from "../../packages/mysql/src/profile.ts";
import { createMySqlContractReconciler } from "../../packages/mysql/src/reconciliation.ts";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.ts";
import { measureNativeProject } from "./measure-native-project.mjs";

assert.ok(process.env.TYPED_SQL_MYSQL_URL, "Set an explicit owned audit server URL");
const driver = await import(
  pathToFileURL(createRequire(new URL("../../packages/mysql/package.json", import.meta.url)).resolve("mysql2/promise"))
    .href
);
const admin = await driver.createConnection(process.env.TYPED_SQL_MYSQL_URL);
const name = `typed_sql_commerce_${randomBytes(8).toString("hex")}`;
const target = new URL(process.env.TYPED_SQL_MYSQL_URL);
target.pathname = `/${name}`;
let created = false;
try {
  await admin.query(`CREATE DATABASE \`${name}\``);
  created = true;
  const setup = await driver.createConnection({ uri: target.href, multipleStatements: true });
  const files = commerceFiles("mysql");
  try {
    for (const [file, source] of Object.entries(files))
      if (file.startsWith("schema/") && file.endsWith(".sql")) await setup.query(source);
  } finally {
    await setup.end();
  }
  const schema = await mysql2({ connectionUri: target.href, schemas: [name] }).introspect();
  assert.match(schema.server.version, /^(?:8\.4|9\.7)\./u);
  const version = schema.server.version.startsWith("9.7.") ? "9.7" : "8.4";
  const { mysql: createCore } =
    version === "8.4" ? { mysql } : await import("../../packages/mysql/src/analysis/core/9.7.ts");
  const profile = mysqlProfile(),
    core = createCore(),
    contribution = createMySqlContractReconciler();
  const report = await measureNativeProject({
    label: `mysql-commerce-${schema.server.version}`,
    fixtureProducer: import.meta.url,
    schema,
    profile,
    files,
    analyze: (sql) => core.analyze(sql, schema),
    adapter: createMySql2NativeContractAdapter({ connectionUri: target.href, schema }),
    contribution,
    policy: {
      mode: "native-required",
      owner: { id: contribution.id, version: contribution.version },
      requiredNativeFacets: ["runtime-type"],
    },
    ...(process.argv[3] ? { scales: process.argv[3].split(",").map(Number) } : {}),
    async beforeOffline() {
      await admin.query(`DROP DATABASE \`${name}\``);
      created = false;
    },
  });
  report.fixture = { tables: Object.keys(schema.tables).length, ownedDatabaseRemovedBeforeOffline: !created };
  await writeFile(
    resolve(process.argv[2] ?? `planning/hybrid-analysis/mysql-${version}-native-project.json`),
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
  try {
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
  } finally {
    await admin.end();
  }
}
