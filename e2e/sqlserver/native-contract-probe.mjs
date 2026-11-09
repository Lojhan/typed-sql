import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sqlserver } from "@typed-sql/sqlserver/analysis/core";
import { sqlServerContractReconciliationOwner } from "@typed-sql/sqlserver/contract-profile";
import {
  createSqlServerNativeContractAdapter,
  SqlServerContractAcquisitionError,
} from "@typed-sql/sqlserver/native-contracts";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { sqlserverProfile } from "@typed-sql/sqlserver/profile";
import { createSqlServerContractReconciler } from "@typed-sql/sqlserver/reconciliation";
import {
  acquireNativeQueryContract,
  createStaticQueryClaim,
  reconcileQueryContract,
} from "../../packages/analysis/dist/packages/analysis/src/index.js";
import { SQLSERVER_LANGUAGE_SUPPORT } from "../../packages/sqlserver/dist/packages/sqlserver/src/support.js";
import { recordNativeCosts } from "../../planning/hybrid-analysis/measure-native.mjs";

const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
assert.ok(password && !/[;{}]/u.test(password));
const major = Number(process.env.TYPED_SQL_SQLSERVER_MAJOR);
assert.ok(SQLSERVER_LANGUAGE_SUPPORT.engineMajors.includes(major));
const levels = SQLSERVER_LANGUAGE_SUPPORT.compatibilityLevels.filter((level) => level <= major * 10);
const build = process.env.TYPED_SQL_SQLSERVER_BUILD;
assert.match(build ?? "", /^\d+\.\d+\.\d+\.\d+$/u);
const name = `typed_sql_contract_${major}_${randomBytes(6).toString("hex")}`;
const dsn = (database) =>
  `Driver={ODBC Driver 18 for SQL Server};Server=127.0.0.1,1433;Database=${database};UID=sa;PWD=${password};Encrypt=yes;TrustServerCertificate=yes;`;
const admin = await createSqlServerOdbcDatabase({ connectionString: dsn("master") });
const evidence = {
  formatVersion: 1,
  major,
  build,
  caseStatus: "incomplete",
  cleanupStatus: "pending",
  cases: [],
  contextAttempts: [],
};
async function stableContext(adapter, compatibility, stage) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const context = await adapter.inspectContext();
      evidence.contextAttempts.push({ compatibility, stage, attempt, status: "observed" });
      return context;
    } catch (error) {
      evidence.contextAttempts.push({ compatibility, stage, attempt, status: error.reason ?? "failed" });
      if (error.reason !== "context-changed" || attempt === 2) throw error;
    }
  }
  throw Error("No stable native context observed");
}
// Owned fixture DDL can advance the log while an acquisition opens its guard. Retry only that
// classified race, keeping the caller's original context and expected outcome unchanged.
async function stableAcquisition(request, compatibility, stage) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await acquireNativeQueryContract(request);
      evidence.contextAttempts.push({ compatibility, stage, attempt, operation: "acquire", status: result.status });
      return result;
    } catch (error) {
      evidence.contextAttempts.push({
        compatibility,
        stage,
        attempt,
        operation: "acquire",
        status: error.reason ?? "failed",
      });
      if (error.reason !== "context-changed" || attempt === 2) throw error;
    }
  }
  throw Error("No stable native acquisition observed");
}
let created = false;
let principalCreated = false;
let resolutionPrincipalCreated = false;
const resolutionPrincipal = `${name}_resolution`;
const principal = `${name}_principal`;
const failures = [];
const profile = sqlserverProfile();
const candidate = (sql, schema) => ({
  sql,
  parameterOccurrences: profile
    .parameterOccurrences(sql, schema)
    .map(({ index, range }) => ({ index, start: range.start, end: range.end })),
});
const servicePool = (setupStatements = []) => ({
  async acquire() {
    const database = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    try {
      for (const statement of setupStatements) await database.queryable.all(statement);
    } catch (error) {
      const [closed] = await Promise.allSettled([database.close()]);
      if (closed.status === "rejected")
        throw new AggregateError([error, closed.reason], "Fixture setup and cleanup failed");
      throw error;
    }
    return {
      all: (text, values) => database.queryable.all(text, values),
      release: () => database.close(),
      discard: () => database.close(),
    };
  },
});
const pool = servicePool();
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
      `CREATE XML SCHEMA COLLECTION dbo.contract_xml AS '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="value" type="xs:string"/></xs:schema>'`,
      "CREATE TABLE dbo.typed_xml_records (id xml(dbo.contract_xml))",
      "CREATE TABLE dbo.clr_records (id hierarchyid)",
      "CREATE TABLE dbo.protected_records (id bigint NOT NULL)",
      "CREATE FUNCTION dbo.contract_filter(@id bigint) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS allowed WHERE @id>=0",
      "CREATE SECURITY POLICY dbo.contract_policy ADD FILTER PREDICATE dbo.contract_filter(id) ON dbo.protected_records WITH (STATE=ON)",
    ])
      await setup.queryable.all(sql);
  } finally {
    await setup.close();
  }
  // This probe owns its disposable server. Create the login before baseline capture so the
  // impersonation proof changes only session identity, not server/database permission records.
  await admin.queryable.all(
    `CREATE LOGIN [${principal}] WITH PASSWORD='Audit_1_${randomBytes(24).toString("hex")}',CHECK_POLICY=OFF`,
  );
  principalCreated = true;
  await admin.queryable.all(`ALTER SERVER ROLE sysadmin ADD MEMBER [${principal}]`);
  // DEFAULT_SCHEMA is ignored for sysadmin logins; use a distinct non-sysadmin with owned metadata access.
  await admin.queryable.all(
    `CREATE LOGIN [${resolutionPrincipal}] WITH PASSWORD='Audit_1_${randomBytes(24).toString("hex")}',CHECK_POLICY=OFF`,
  );
  resolutionPrincipalCreated = true;
  await admin.queryable.all(`GRANT VIEW SERVER STATE TO [${resolutionPrincipal}]`);
  if (major >= 16) await admin.queryable.all(`GRANT VIEW SERVER PERFORMANCE STATE TO [${resolutionPrincipal}]`);
  const resolutionSetup = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
  try {
    await resolutionSetup.queryable.all("CREATE SCHEMA contract_resolution");
    await resolutionSetup.queryable.all(
      `CREATE USER [${resolutionPrincipal}] FOR LOGIN [${resolutionPrincipal}] WITH DEFAULT_SCHEMA=dbo`,
    );
    await resolutionSetup.queryable.all(`ALTER ROLE db_owner ADD MEMBER [${resolutionPrincipal}]`);
  } finally {
    await resolutionSetup.close();
  }
  for (const compatibility of levels) {
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
    const baselineContext = await stableContext(adapter, compatibility, "baseline");
    const principalAdapter = createSqlServerNativeContractAdapter({
      pool: servicePool([`EXECUTE AS LOGIN='${principal}'`]),
      schema,
    });
    const principalContext = await stableContext(principalAdapter, compatibility, "authorization-principal");
    assert.equal(principalContext.schemaHash, baselineContext.schemaHash);
    assert.equal(principalContext.codecHash, baselineContext.codecHash);
    assert.notEqual(principalContext.databaseContextHash, baselineContext.databaseContextHash);
    assert.deepEqual(
      await stableAcquisition(
        {
          adapter: principalAdapter,
          context: baselineContext,
          candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
        },
        compatibility,
        "context-control",
      ),
      { status: "unavailable", reason: "context-mismatch" },
      "Distinct server logins cannot reuse context even when both map to dbo with sysadmin permissions",
    );
    evidence.cases.push({ compatibility, id: "principal-context-mismatch", status: "pass" });
    const resolutionPool = servicePool([`EXECUTE AS LOGIN='${resolutionPrincipal}'`]);
    const resolutionAdapter = createSqlServerNativeContractAdapter({ pool: resolutionPool, schema });
    const resolutionFacts = async () => {
      const lease = await resolutionPool.acquire();
      try {
        const rows = await lease.all(
          "SELECT SCHEMA_NAME() AS default_schema,USER_NAME() AS database_user,SUSER_SNAME() AS current_login,IS_SRVROLEMEMBER('sysadmin') AS sysadmin",
        );
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].sysadmin), 0);
        return rows[0];
      } finally {
        await lease.release();
      }
    };
    const beforeResolution = await resolutionFacts();
    assert.equal(beforeResolution.default_schema, "dbo");
    const resolutionContext = await stableContext(resolutionAdapter, compatibility, "default-schema-before");
    assert.equal(
      (
        await stableAcquisition(
          {
            adapter: resolutionAdapter,
            context: resolutionContext,
            candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
          },
          compatibility,
          "context-control",
        )
      ).status,
      "acquired",
    );
    const resolutionMutation = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    try {
      await resolutionMutation.queryable.all(
        `ALTER USER [${resolutionPrincipal}] WITH DEFAULT_SCHEMA=contract_resolution`,
      );
      const afterResolution = await resolutionFacts();
      assert.deepEqual(afterResolution, { ...beforeResolution, default_schema: "contract_resolution" });
      const changedResolution = await stableContext(resolutionAdapter, compatibility, "default-schema-after");
      assert.equal(changedResolution.schemaHash, resolutionContext.schemaHash);
      assert.equal(changedResolution.codecHash, resolutionContext.codecHash);
      assert.notEqual(changedResolution.databaseContextHash, resolutionContext.databaseContextHash);
      assert.deepEqual(
        await stableAcquisition(
          {
            adapter: resolutionAdapter,
            context: resolutionContext,
            candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
          },
          compatibility,
          "context-control",
        ),
        { status: "unavailable", reason: "context-mismatch" },
      );
      assert.equal(
        (
          await stableAcquisition(
            {
              adapter: resolutionAdapter,
              context: changedResolution,
              candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
            },
            compatibility,
            "context-control",
          )
        ).status,
        "acquired",
      );
      evidence.cases.push({
        compatibility,
        id: "default-schema-context-mismatch",
        status: "pass",
        before: beforeResolution,
        after: afterResolution,
      });
    } finally {
      try {
        await resolutionMutation.queryable.all(`ALTER USER [${resolutionPrincipal}] WITH DEFAULT_SCHEMA=dbo`);
      } finally {
        await resolutionMutation.close();
      }
    }
    const settingAdapter = createSqlServerNativeContractAdapter({ pool: servicePool(["SET DATEFIRST 1"]), schema });
    await assert.rejects(settingAdapter.inspectContext(), /unsupported-context/u);
    await assert.rejects(
      acquireNativeQueryContract({
        adapter: settingAdapter,
        context: baselineContext,
        candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
      }),
      /unsupported-context/u,
    );
    evidence.cases.push({ compatibility, id: "semantic-setting-unavailable", status: "pass" });
    const changedPolicyAdapter = createSqlServerNativeContractAdapter({
      pool,
      schema,
      typePolicy: { ...profile.defaultTypePolicy, bigint: "string" },
    });
    const changedPolicyContext = await stableContext(changedPolicyAdapter, compatibility, "codec-policy");
    assert.equal(changedPolicyContext.databaseContextHash, baselineContext.databaseContextHash);
    assert.notEqual(changedPolicyContext.typePolicyHash, baselineContext.typePolicyHash);
    assert.notEqual(changedPolicyContext.codecHash, baselineContext.codecHash);
    assert.deepEqual(
      await stableAcquisition(
        {
          adapter: changedPolicyAdapter,
          context: baselineContext,
          candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
        },
        compatibility,
        "context-control",
      ),
      { status: "unavailable", reason: "context-mismatch" },
      "A changed BIGINT decoding policy cannot reuse the old native context",
    );
    evidence.cases.push({ compatibility, id: "codec-policy-context-mismatch", status: "pass" });
    const permissionSetup = await createSqlServerOdbcDatabase({ connectionString: dsn(name) });
    try {
      await permissionSetup.queryable.all("GRANT SELECT ON dbo.records TO contract_context_audit");
      const granted = await stableContext(adapter, compatibility, "permission-grant");
      assert.notEqual(granted.databaseContextHash, baselineContext.databaseContextHash);
      assert.equal(granted.schemaHash, baselineContext.schemaHash);
      assert.deepEqual(
        await stableAcquisition(
          {
            adapter,
            context: baselineContext,
            candidate: candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema),
          },
          compatibility,
          "context-control",
        ),
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
    const alternative = levels.find((level) => level !== compatibility) ?? Math.min(...levels) - 10;
    const profileCandidate = candidate("SELECT CAST(@__typed_sql_1 AS bigint) AS value", schema);
    const profileAcquire = (context, stage) =>
      stableAcquisition({ adapter, context, candidate: profileCandidate }, compatibility, stage);
    const beforeProfile = await stableContext(adapter, compatibility, "engine-profile-before");
    assert.equal((await profileAcquire(beforeProfile, "engine-profile-own")).status, "acquired");
    try {
      await admin.queryable.all(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL=${alternative}`);
      const changed = await admin.queryable.all("SELECT compatibility_level FROM sys.databases WHERE name=?", [name]);
      assert.equal(changed.length, 1);
      assert.equal(Number(changed[0].compatibility_level), alternative);
      if (levels.includes(alternative)) {
        const afterProfile = await stableContext(adapter, compatibility, "engine-profile-after");
        assert.equal(afterProfile.schemaHash, beforeProfile.schemaHash);
        assert.equal(afterProfile.typePolicyHash, beforeProfile.typePolicyHash);
        assert.equal(afterProfile.codecHash, beforeProfile.codecHash);
        assert.notEqual(afterProfile.databaseContextHash, beforeProfile.databaseContextHash);
        assert.deepEqual(await profileAcquire(beforeProfile, "engine-profile-stale"), {
          status: "unavailable",
          reason: "context-mismatch",
        });
        assert.equal((await profileAcquire(afterProfile, "engine-profile-fresh")).status, "acquired");
      } else {
        // The oldest engine has only one declared profile. Its real lower profile must remain unavailable.
        await assert.rejects(
          createSqlServerOdbcDatabase({ connectionString: dsn(name) }),
          (error) =>
            error instanceof TypeError &&
            error.message === "SQL Server direct ODBC requires a qualified boxed engine and compatibility level",
        );
        await assert.rejects(
          acquireNativeQueryContract({ adapter, context: beforeProfile, candidate: profileCandidate }),
          (error) => error instanceof SqlServerContractAcquisitionError && error.reason === "native-failure",
        );
      }
      evidence.cases.push({
        compatibility,
        id: "compatibility-profile-context-invalidation",
        status: "pass",
        from: compatibility,
        to: alternative,
        outcome: levels.includes(alternative) ? "context-mismatch" : "unsupported-at-connection",
      });
    } finally {
      await admin.queryable.all(`ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL=${compatibility}`);
    }
    const restoredSettings = await admin.queryable.all("SELECT compatibility_level FROM sys.databases WHERE name=?", [
      name,
    ]);
    assert.equal(restoredSettings.length, 1);
    assert.equal(Number(restoredSettings[0].compatibility_level), compatibility);
    const restoredProfile = await stableContext(adapter, compatibility, "engine-profile-restored");
    assert.equal(restoredProfile.schemaHash, beforeProfile.schemaHash);
    assert.equal(restoredProfile.codecHash, beforeProfile.codecHash);
    assert.equal((await profileAcquire(restoredProfile, "engine-profile-restored-acquisition")).status, "acquired");
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
    for (const relation of [
      "record_view",
      "computed_records",
      "alias_records",
      "typed_xml_records",
      "clr_records",
      "protected_records",
    ]) {
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
  evidence.caseStatus = "passed";
  console.log(`SQL Server ${major}: guarded native query contracts passed`);
} catch (error) {
  failures.push(error);
}
const [cleanup] = await Promise.allSettled([
  (async () => {
    try {
      try {
        if (created) {
          await admin.queryable.all(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
          await admin.queryable.all(`DROP DATABASE [${name}]`);
        }
      } finally {
        try {
          if (principalCreated) await admin.queryable.all(`DROP LOGIN [${principal}]`);
        } finally {
          if (resolutionPrincipalCreated) await admin.queryable.all(`DROP LOGIN [${resolutionPrincipal}]`);
        }
      }
    } finally {
      await admin.close();
    }
  })(),
]);
evidence.cleanupStatus = cleanup.status === "fulfilled" ? "passed" : "failed";
if (cleanup.status === "rejected") failures.push(cleanup.reason);
const [publication] = await Promise.allSettled([
  (async () => {
    const output = resolve(`../../artifacts/sqlserver/native-contracts-${major}.json`);
    await mkdir(resolve("../../artifacts/sqlserver"), { recursive: true });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  })(),
]);
if (publication.status === "rejected") failures.push(publication.reason);
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "SQL Server qualification or cleanup failed");
