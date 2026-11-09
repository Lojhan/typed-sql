import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sqlserver } from "../../packages/sqlserver/src/analysis/core.ts";
import { createSqlServerNativeContractAdapter } from "../../packages/sqlserver/src/native-contracts.ts";
import { createSqlServerOdbcDatabase, sqlServerOdbc } from "../../packages/sqlserver/src/odbc.ts";
import { sqlserverProfile } from "../../packages/sqlserver/src/profile.ts";
import { createSqlServerContractReconciler } from "../../packages/sqlserver/src/reconciliation.ts";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.ts";
import { measureNativeProject } from "./measure-native-project.mjs";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password));
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
assert.ok([14, 15, 16, 17].includes(major));
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const admin = await createSqlServerOdbcDatabase({ connectionString: dsn("master") });
try {
  for (const compatibility of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
    const name = `typed_sql_commerce_${randomBytes(8).toString("hex")}`;
    let created = false;
    try {
      await admin.queryable.all(`CREATE DATABASE [${name}]`);
      created = true;
      await admin.queryable.all(`ALTER DATABASE [${name}] SET QUERY_STORE=OFF`);
      await admin.queryable.all(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL=${compatibility}`);
      const setup = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
      const files = commerceFiles("sqlserver");
      try {
        for (const [file, source] of Object.entries(files))
          if (file.startsWith("schema/") && file.endsWith(".sql")) await setup.queryable.all(source);
      } finally {
        await setup.close();
      }
      const schema = await sqlServerOdbc({ connectionString: dsn(name), includeSchemas: ["dbo"] }).introspect({});
      const pool = {
        async acquire() {
          const database = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
          return {
            all: (text, values) => database.queryable.all(text, values),
            release: () => database.close(),
            discard: () => database.close(),
          };
        },
      };
      const profile = sqlserverProfile(),
        core = sqlserver(),
        contribution = createSqlServerContractReconciler();
      const report = await measureNativeProject({
        label: `sqlserver-commerce-${major}-${compatibility}`,
        fixtureProducer: import.meta.url,
        schema,
        profile,
        files,
        analyze: (sql) => core.analyze(sql, schema),
        adapter: createSqlServerNativeContractAdapter({ pool, schema }),
        contribution,
        policy: {
          mode: "native-required",
          owner: { id: contribution.id, version: contribution.version },
          requiredNativeFacets: ["runtime-type"],
        },
        ...(process.argv[3] ? { scales: process.argv[3].split(",").map(Number) } : {}),
        async beforeOffline() {
          await admin.queryable.all(`DROP DATABASE [${name}]`);
          created = false;
        },
      });
      report.fixture = { tables: Object.keys(schema.tables).length, ownedDatabaseRemovedBeforeOffline: !created };
      const destination = resolve(process.argv[2] ?? "artifacts/sqlserver/native-project", `${report.label}.json`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        JSON.stringify({
          label: report.label,
          acquisitions: report.acquisitions,
          offlineNativeCalls: report.offlineNativeCalls,
        }),
      );
    } finally {
      if (created) await admin.queryable.all(`DROP DATABASE [${name}]`);
    }
  }
} finally {
  await admin.close();
}
