import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sqlserver } from "@typed-sql/sqlserver/analysis";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { sqlserverProfile } from "@typed-sql/sqlserver/profile";
import {
  acquireNativeQueryContract,
  createStaticQueryClaim,
  reconcileQueryContract,
} from "../../packages/analysis/dist/packages/analysis/src/index.js";
import { sqlServerContractReconciliationOwner } from "../../packages/sqlserver/dist/packages/sqlserver/src/contract-profile.js";
import { createSqlServerNativeContractAdapter } from "../../packages/sqlserver/dist/packages/sqlserver/src/native-contracts.js";
import { createSqlServerContractReconciler } from "../../packages/sqlserver/dist/packages/sqlserver/src/reconciliation.js";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password));
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
assert.ok([14, 15, 16, 17].includes(major));
const build = process.env.TYPED_SQL_SQLSERVER_BUILD;
assert.match(build ?? "", /^\d+\.\d+\.\d+\.\d+$/u);
const name = `typed_sql_contract_${major}_${randomBytes(6).toString("hex")}`;
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const admin = await createSqlServerOdbcDatabase({ connectionString: dsn("master") });
const evidence = { formatVersion: 1, major, build, cases: [] };
let created = false;
const profile = sqlserverProfile();
const candidate = (sql, schema) => ({
  sql,
  parameterOccurrences: profile
    .parameterOccurrences(sql, schema)
    .map(({ index, range }) => ({ index, start: range.start, end: range.end })),
});
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
try {
  await admin.queryable.all(`CREATE DATABASE [${name}]`);
  created = true;
  // This fixture owns its database. Native acquisition does not alter user database settings.
  await admin.queryable.all(`ALTER DATABASE [${name}] SET QUERY_STORE=OFF`);
  for (const compatibility of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
    await admin.queryable.all(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL=${compatibility}`);
    const connection = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    const schema = { formatVersion: 1, dialect: "sqlserver", tables: {}, server: connection.serverEvidence };
    await connection.close();
    assert.equal(schema.server.version, build);
    assert.equal(schema.server.settings.compatibilityLevel, compatibility);
    const adapter = createSqlServerNativeContractAdapter({ pool, schema });
    const policy = {
      mode: "native-required",
      owner: sqlServerContractReconciliationOwner,
      requiredNativeFacets: ["runtime-type"],
    };
    for (const [id, sql] of [
      ["bigint-parameter", "SELECT CAST(@__typed_sql_1 AS bigint) AS value"],
      ["iif", "SELECT IIF(1=1,CAST(1 AS bigint),CAST(2 AS bigint)) AS value"],
      ["decimal", "SELECT CAST(1 AS decimal(38,10)) AS value"],
      ["concat", "SELECT CONCAT(N'hello',N'world') AS value"],
    ]) {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await acquireNativeQueryContract({
            adapter,
            candidate: candidate(sql, schema),
            context: await adapter.inspectContext(),
          });
          break;
        } catch (error) {
          if (error.reason !== "context-changed" || attempt === 2) throw error;
        }
      }
      assert.equal(result.status, "acquired");
      const qualified = reconcileQueryContract({
        nativeContract: result.contract,
        staticClaim: createStaticQueryClaim({
          sql,
          context: result.contract.context,
          analysis: sqlserver().analyze(sql, schema),
        }),
        contribution: createSqlServerContractReconciler(),
        policy,
      });
      assert.equal(qualified.status, "qualified", JSON.stringify(qualified.report));
      evidence.cases.push({ compatibility, id, status: "pass", contract: qualified.contract });
    }
  }
  const output = resolve(`../../artifacts/sqlserver/native-contracts-${major}.json`);
  await mkdir(resolve("../../artifacts/sqlserver"), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`SQL Server ${major}: guarded native query contracts passed`);
} finally {
  if (created) {
    await admin.queryable.all(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
    await admin.queryable.all(`DROP DATABASE [${name}]`);
  }
  await admin.close();
}
