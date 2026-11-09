import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sqlserver } from "@typed-sql/sqlserver/analysis/core";
import { sqlServerContractReconciliationOwner } from "@typed-sql/sqlserver/contract-profile";
import { createSqlServerNativeContractAdapter } from "@typed-sql/sqlserver/native-contracts";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { sqlserverProfile } from "@typed-sql/sqlserver/profile";
import { createSqlServerContractReconciler } from "@typed-sql/sqlserver/reconciliation";
import {
  acquireNativeQueryContract,
  createStaticQueryClaim,
  reconcileQueryContract,
} from "../../packages/analysis/dist/packages/analysis/src/index.js";
import { recordNativeCosts } from "../../planning/hybrid-analysis/measure-native.mjs";

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
  const setup = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
  try {
    for (const sql of [
      "CREATE TABLE dbo.records (id bigint NOT NULL, quantity int NOT NULL, amount decimal(12,2) NULL)",
      "CREATE ROLE contract_context_audit",
      "INSERT dbo.records VALUES (1,2,3.25)",
      "CREATE VIEW dbo.record_view AS SELECT id FROM dbo.records",
      "CREATE TABLE dbo.computed_records (id bigint NOT NULL, computed AS id+1)",
      "CREATE TYPE dbo.contract_id FROM bigint NOT NULL",
      "CREATE TABLE dbo.alias_records (id dbo.contract_id)",
      "CREATE TABLE dbo.protected_records (id bigint NOT NULL)",
      "CREATE FUNCTION dbo.contract_filter(@id bigint) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS allowed WHERE @id>=0",
      "CREATE SECURITY POLICY dbo.contract_policy ADD FILTER PREDICATE dbo.contract_filter(id) ON dbo.protected_records WITH (STATE=ON)",
    ])
      await setup.queryable.all(sql);
  } finally {
    await setup.close();
  }
  for (const compatibility of [140, 150, 160, 170].filter((level) => level <= major * 10)) {
    await admin.queryable.all(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL=${compatibility}`);
    const connection = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    const schema = {
      formatVersion: 1,
      dialect: "sqlserver",
      tables: {
        records: {
          schema: "dbo",
          name: "records",
          columns: {
            id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
            quantity: { name: "quantity", databaseType: "int", tsType: "number", nullable: false },
            amount: { name: "amount", databaseType: "decimal(12,2)", tsType: "string", nullable: true },
          },
        },
      },
      server: connection.serverEvidence,
    };
    await connection.close();
    assert.equal(schema.server.version, build);
    assert.equal(schema.server.settings.compatibilityLevel, compatibility);
    const adapter = createSqlServerNativeContractAdapter({ pool, schema });
    const baselineContext = await adapter.inspectContext();
    const changedPolicyAdapter = createSqlServerNativeContractAdapter({
      pool,
      schema,
      typePolicy: { ...profile.defaultTypePolicy, bigint: "string" },
    });
    const changedPolicyContext = await changedPolicyAdapter.inspectContext();
    assert.equal(changedPolicyContext.databaseContextHash, baselineContext.databaseContextHash);
    assert.notEqual(changedPolicyContext.typePolicyHash, baselineContext.typePolicyHash);
    assert.notEqual(changedPolicyContext.codecHash, baselineContext.codecHash);
    assert.deepEqual(
      await acquireNativeQueryContract({
        adapter: changedPolicyAdapter,
        context: baselineContext,
        candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
      }),
      { status: "unavailable", reason: "context-mismatch" },
      "A changed BIGINT decoding policy cannot reuse the old native context",
    );
    evidence.cases.push({ compatibility, id: "codec-policy-context-mismatch", status: "pass" });
    const permissionSetup = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    try {
      await permissionSetup.queryable.all("GRANT SELECT ON dbo.records TO contract_context_audit");
      const granted = await adapter.inspectContext();
      assert.notEqual(granted.databaseContextHash, baselineContext.databaseContextHash);
      assert.equal(granted.schemaHash, baselineContext.schemaHash);
      assert.deepEqual(
        await acquireNativeQueryContract({
          adapter,
          context: baselineContext,
          candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
        }),
        { status: "unavailable", reason: "context-mismatch" },
        "A permission grant must retire context even when the current principal and schema are unchanged",
      );
      evidence.cases.push({ compatibility, id: "permission-grant-context-mismatch", status: "pass" });
    } finally {
      try {
        await permissionSetup.queryable.all("REVOKE SELECT ON dbo.records FROM contract_context_audit");
      } finally {
        await permissionSetup.close();
      }
    }
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
      ["table-parameter", "SELECT a.id AS value FROM dbo.records a WHERE a.id=@__typed_sql_1"],
      [
        "table-join",
        "SELECT a.id AS value,b.amount AS amount FROM dbo.records a LEFT JOIN dbo.records b ON a.id=b.id WHERE a.quantity>0",
      ],
      ["table-star", "SELECT a.* FROM dbo.records a WHERE a.id=1"],
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
      if (id === "bigint-parameter")
        await recordNativeCosts({
          label: `sqlserver-${build}-compat-${compatibility}`,
          serverVersion: build,
          schema,
          adapter,
          candidate: candidate(sql, schema),
          analyze: (text) => sqlserver().analyze(text, schema),
          contribution: createSqlServerContractReconciler(),
          policy,
        });
      evidence.cases.push({ compatibility, id, status: "pass", contract: qualified.contract });
    }
    for (const relation of ["record_view", "computed_records", "alias_records", "protected_records"]) {
      const session = await adapter.open();
      try {
        await assert.rejects(
          session.describe(candidate(`SELECT id FROM dbo.${relation}`, schema)),
          /unsupported-statement/u,
        );
      } finally {
        await session.close();
      }
      evidence.cases.push({ compatibility, id: `reject-${relation}`, status: "pass" });
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
