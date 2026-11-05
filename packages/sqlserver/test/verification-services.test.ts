import { describe, it, strict } from "poku";
import {
  buildQueryManifest,
  collectQueryVerificationCandidates,
  serializeQueryVerificationProof,
  verifyQueryManifest,
} from "../../compiler/src/index.js";
import { sqlserver } from "../src/browser.js";
import {
  compareSqlServerDatabaseTypes,
  createSqlServerLiveVerifier,
  sqlServerVerificationQueries,
} from "../src/live-verifier.js";
import {
  createSqlServerPlanInspector,
  normalizeSqlServerShowplan,
  sqlServerPlanQueries,
} from "../src/plan-inspector.js";
import { maturitySnapshot } from "./helpers/maturity-corpus.js";
import { fingerprint, ServiceHarness, showplan } from "./helpers/verification-services.js";

await describe("SQL Server native verification services", async () => {
  await it("describes bound compiler SQL natively and retains exact physical precision", async () => {
    const pool = new ServiceHarness(),
      verifier = createSqlServerLiveVerifier({ pool });
    const server = await verifier.server();
    strict.equal(server.version, "17.0.5035.5");
    strict.ok(!JSON.stringify(server).includes("private_database"));
    const sql = "SELECT amount FROM dbo.widgets WHERE id=@__typed_sql_1";
    const result = await verifier.verify({ fingerprint, sql, operation: "read" });
    strict.deepEqual(result.columns, [{ index: 1, name: "amount", databaseType: "decimal(12,2)", nullable: false }]);
    strict.deepEqual(result.parameters, [{ index: 1, name: "@__typed_sql_1", databaseType: "bigint" }]);
    strict.deepEqual(pool.calls.find((call) => call.sql === sqlServerVerificationQueries.columns)?.values, [
      sql,
      "@__typed_sql_1 bigint",
    ]);
    strict.ok(!pool.calls.some((call) => call.sql === sql));
    pool.scale = 4;
    const drift = await verifier.verify({ fingerprint, sql, operation: "read" });
    strict.equal(
      verifier.compareDatabaseTypes?.("decimal(12,2)", drift.columns[0]!.databaseType!, "column"),
      "different",
    );
    strict.equal(pool.discarded, 0);
    await verifier.close();
    strict.equal(pool.closed, 0);
    await strict.rejects(verifier.verify({ fingerprint, sql, operation: "read" }), /closed/u);
  });
  await it("keeps canonical parameter ordering independent of native metadata order", async () => {
    const pool = new ServiceHarness();
    pool.parameters = [
      { name: "@__typed_sql_2", suggested_system_type_name: "int", suggested_is_input: 1, suggested_is_output: 0 },
      { name: "@__typed_sql_1", suggested_system_type_name: "bigint", suggested_is_input: 1, suggested_is_output: 0 },
    ];
    const verifier = createSqlServerLiveVerifier({ pool });
    const result = await verifier.verify({
      fingerprint,
      operation: "read",
      sql: "SELECT amount FROM dbo.widgets WHERE quantity=@__typed_sql_2 AND id=@__typed_sql_1",
    });
    strict.deepEqual(
      result.parameters.map((field) => field.index),
      [1, 2],
    );
    strict.equal(
      pool.calls.find((call) => call.sql === sqlServerVerificationQueries.columns)?.values[1],
      "@__typed_sql_1 bigint, @__typed_sql_2 int",
    );
    await verifier.close();
  });
  await it("describes DML OUTPUT and commands as metadata without executing mutation", async () => {
    const pool = new ServiceHarness(),
      verifier = createSqlServerLiveVerifier({ pool });
    const sql = "UPDATE dbo.widgets SET amount=1 OUTPUT inserted.amount";
    const result = await verifier.verify({ fingerprint, sql, operation: "write" });
    strict.equal(result.columns.length, 1);
    pool.columns = [];
    const command = await verifier.verify({ fingerprint, sql: "DELETE FROM dbo.widgets", operation: "write" });
    strict.deepEqual(command.columns, []);
    strict.ok(!pool.calls.some((call) => call.sql.startsWith("UPDATE") || call.sql.startsWith("DELETE")));
    await verifier.close();
  });
  await it("rejects forbidden or mislabeled SQL before acquiring a native session", async () => {
    const pool = new ServiceHarness(),
      verifier = createSqlServerLiveVerifier({ pool });
    for (const sql of [
      "DROP TABLE widgets",
      "EXEC sp_executesql N'SELECT 1'",
      "SELECT id FROM widgets; DELETE FROM widgets",
      "SELECT id INTO stolen FROM widgets",
      "SELECT @arbitrary AS value",
      "SELECT ? AS value",
      "SELECT @__typed_sql_2 AS value",
      "SELECT 'literal\0value' AS value",
      "SELECT '\ud800' AS value",
    ]) {
      await strict.rejects(verifier.verify({ fingerprint, sql, operation: "read" }));
    }
    await strict.rejects(verifier.verify({ fingerprint, sql: "DELETE FROM widgets", operation: "read" }));
    await strict.rejects(
      verifier.verify({ fingerprint: "private-secret", sql: "SELECT 1 AS value", operation: "read" }),
    );
    strict.equal(pool.acquired, 0);
    await verifier.close();
  });
  await it("quarantines metadata failures and never exposes native SQL errors", async () => {
    for (const corrupt of ["ordinal", "opaque", "error", "duplicate", "parameter"]) {
      const pool = new ServiceHarness(),
        verifier = createSqlServerLiveVerifier({ pool });
      if (corrupt === "parameter")
        pool.parameters = [
          {
            name: "@__typed_sql_1;DROP",
            suggested_system_type_name: "bigint",
            suggested_is_input: 1,
            suggested_is_output: 0,
          },
        ];
      else if (corrupt === "opaque")
        pool.columns = [{ is_hidden: 0, column_ordinal: 1, name: "amount", system_type_name: null, is_nullable: 0 }];
      else if (corrupt === "error") pool.fail = sqlServerVerificationQueries.columns;
      else if (corrupt === "duplicate")
        pool.columns = [1, 2].map((column_ordinal) => ({
          is_hidden: 0,
          column_ordinal,
          name: "same",
          system_type_name: "int",
          is_nullable: 0,
        }));
      else
        pool.columns = [{ is_hidden: 0, column_ordinal: 2, name: "amount", system_type_name: "int", is_nullable: 0 }];
      await strict.rejects(
        verifier.verify({
          fingerprint,
          sql: "SELECT amount FROM dbo.widgets WHERE id=@__typed_sql_1",
          operation: "read",
        }),
        (error: unknown) =>
          error instanceof Error && !error.message.includes("recognizable-secret") && error.cause === undefined,
      );
      strict.equal(pool.discarded, 1);
      strict.equal(pool.released, 0);
      await verifier.close();
    }
  });
  await it("compares native widths, precision and attested column collations", () => {
    strict.equal(compareSqlServerDatabaseTypes("numeric(12,2)", "decimal(12,2)", "column"), "equal");
    strict.equal(compareSqlServerDatabaseTypes("nvarchar(40)", "nvarchar(80)", "column"), "different");
    strict.equal(compareSqlServerDatabaseTypes("dbo.Opaque", "bigint", "column"), "unavailable");
    strict.equal(
      compareSqlServerDatabaseTypes("nvarchar(40) COLLATE Latin1_General_100_CI_AS", "nvarchar(40)", "parameter"),
      "unavailable",
    );
    strict.equal(
      compareSqlServerDatabaseTypes("nvarchar(40)", "nvarchar(40) COLLATE Latin1_General_100_CI_AS", "column"),
      "equal",
    );
    strict.equal(
      compareSqlServerDatabaseTypes(
        "nvarchar(40) COLLATE Latin1_General_100_CS_AS",
        "nvarchar(40) COLLATE Latin1_General_100_CI_AS",
        "column",
      ),
      "different",
    );
  });
  await it("captures one value-free SHOWPLAN batch and restores the session before release", async () => {
    const pool = new ServiceHarness(),
      inspector = createSqlServerPlanInspector({ pool, ownsPool: true });
    const environment = await inspector.environment();
    strict.match(environment.statisticsFingerprint, /^sha256:[a-f\d]{64}$/u);
    strict.ok(!JSON.stringify(environment).includes("private_database"));
    const evidence = await inspector.capture({
      fingerprint,
      sql: "SELECT amount FROM dbo.widgets WHERE id=@__typed_sql_1",
      operation: "read",
      parameterCount: 1,
    });
    strict.deepEqual(evidence, {
      totalCost: 0.02,
      estimatedRows: 1.5,
      nodes: [
        { kind: "Index Seek", estimatedRows: 1.5, estimatedCost: 0.02, relation: "dbo.widgets", index: "IX_widgets" },
      ],
    });
    strict.equal(pool.showplan, false);
    strict.ok(pool.calls.some((call) => call.sql.startsWith("DECLARE @__typed_sql_1 bigint;\nSELECT")));
    strict.ok(!JSON.stringify(evidence).includes("recognizable-secret"));
    strict.ok(!JSON.stringify(evidence).includes("StatementText"));
    pool.statisticsRows = "20";
    strict.notEqual((await inspector.environment()).statisticsFingerprint, environment.statisticsFingerprint);
    await inspector.close();
    await inspector.close();
    strict.equal(pool.closed, 1);
  });
  await it("resets or quarantines every SHOWPLAN failure without falling back to execution", async () => {
    for (const step of ["enable", "capture", "disable", "xml"]) {
      const pool = new ServiceHarness(),
        inspector = createSqlServerPlanInspector({ pool });
      if (step === "enable") pool.fail = sqlServerPlanQueries.on;
      if (step === "capture") pool.fail = "SELECT amount FROM dbo.widgets";
      if (step === "disable") pool.fail = sqlServerPlanQueries.off;
      if (step === "xml") pool.xml = "<not-a-plan/>";
      await strict.rejects(
        inspector.capture({ fingerprint, sql: "SELECT amount FROM dbo.widgets", operation: "read", parameterCount: 0 }),
        /native verification service failed/u,
      );
      strict.ok(pool.calls.some((call) => call.sql === sqlServerPlanQueries.off));
      strict.equal(pool.discarded, 1);
      strict.equal(pool.released, 0);
      if (step !== "disable") strict.equal(pool.showplan, false);
      await inspector.close();
    }
  });
  await it("rejects invalid planning counts, samples and writes before acquisition", async () => {
    const pool = new ServiceHarness(),
      inspector = createSqlServerPlanInspector({ pool });
    for (const request of [
      { sql: "SELECT id FROM widgets", operation: "read" as const, parameterCount: 1 },
      { sql: "SELECT id FROM widgets", operation: "read" as const, parameterCount: 0, values: [] },
      { sql: "DELETE FROM widgets", operation: "write" as const, parameterCount: 0 },
    ])
      await strict.rejects(inspector.capture({ fingerprint, ...request }));
    strict.equal(pool.acquired, 0);
    await inspector.close();
  });
  await it("fails closed on unknown engines and incompatible pool sessions", async () => {
    const pool = new ServiceHarness(),
      verifier = createSqlServerLiveVerifier({ pool });
    await verifier.server();
    pool.version = "18.0.1.0";
    await strict.rejects(verifier.verify({ fingerprint, sql: "SELECT amount FROM dbo.widgets", operation: "read" }));
    strict.equal(pool.discarded, 1);
    await verifier.close();
  });
  await it("rejects unsafe XML expansion, malformed plans and unsupported estimates", () => {
    for (const xml of [
      "<!DOCTYPE a [<!ENTITY external SYSTEM 'file:///secret'>]>",
      showplan.replace("<BatchSequence>", "<![CDATA[private]]><BatchSequence>"),
      showplan.replace("Index Seek", "unknown-private-literal"),
      showplan.replace('EstimateRows="1.5"', 'EstimateRows="NaN"'),
      showplan.replace('EstimateRows="1.5"', 'EstimateRows="-1"'),
      showplan.replace('EstimateRows="1.5"', 'EstimateRows="1e999"'),
      showplan.replace("</ShowPlanXML>", "</Wrong>"),
      showplan + showplan,
      `private${showplan}`,
      `${showplan}private`,
      showplan.replace("<QueryPlan>", "<QueryPlan><QueryPlan>"),
      showplan.replace('Schema="[dbo]"', 'Schema="&external;"'),
      showplan.replace('PhysicalOp="Index Seek"', 'PhysicalOp="Index Seek" PhysicalOp="Table Scan"'),
    ])
      strict.throws(() => normalizeSqlServerShowplan(xml));
    strict.throws(() => normalizeSqlServerShowplan("x".repeat(8 * 1024 * 1024 + 1)));
    strict.throws(() =>
      normalizeSqlServerShowplan(showplan.replace("<QueryPlan>", `<QueryPlan>${"<Nested>".repeat(257)}`)),
    );
  });
  await it("reports real SQL native precision drift through the common compiler proof", async () => {
    const dialect = sqlserver(),
      schema = maturitySnapshot(),
      rootDir = "/sqlserver-verification",
      projects = [`${rootDir}/tsconfig.json`];
    const sources = [
      {
        file: `${rootDir}/query.ts`,
        source:
          '// 😀 original source\nimport { sql } from "@typed-sql/sqlserver";\nexport const query=sql`SELECT amount FROM dbo.widgets WHERE id=${1n}`;',
      },
    ];
    const manifest = buildQueryManifest({
      rootDir,
      sources,
      projects,
      dialect,
      schema,
      compilerVersion: "service-test",
    }).manifest;
    const candidates = collectQueryVerificationCandidates({ manifest, rootDir, sources, projects, dialect, schema });
    const pool = new ServiceHarness();
    pool.scale = 4;
    const verifier = createSqlServerLiveVerifier({ pool });
    const result = await verifyQueryManifest({ manifest, candidates, verifier });
    strict.equal(result.mismatched, 1);
    strict.equal(result.verified, 0);
    const entry = result.proof.entries.find((entry) => entry.status === "mismatch");
    if (entry?.status !== "mismatch") strict.fail("Expected native precision mismatch");
    strict.deepEqual(entry.source, candidates[0]!.source);
    strict.equal(entry.variantFingerprint, candidates[0]!.variantFingerprint);
    strict.ok(
      entry.mismatches.some(
        (m) => m.kind === "database-type" && m.expected === "decimal(12,2)" && m.actual === "decimal(12,4)",
      ),
    );
    strict.ok(!serializeQueryVerificationProof(result.proof).includes("SELECT amount"));
    await verifier.close();
  });
  await it("waits for pending native work before owned close and rejects retired service use", async () => {
    const pool = new ServiceHarness();
    const original = pool.query.bind(pool);
    let signal!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pool.query = async (sql, values = []) => {
      if (sql === sqlServerVerificationQueries.columns) {
        signal();
        await gate;
      }
      return original(sql, values);
    };
    const verifier = createSqlServerLiveVerifier({ pool, ownsPool: true });
    const pending = verifier.verify({ fingerprint, sql: "SELECT amount FROM dbo.widgets", operation: "read" });
    await started;
    const closing = verifier.close();
    strict.equal(pool.closed, 0);
    await strict.rejects(verifier.server(), /closed/u);
    release();
    await pending;
    await closing;
    strict.equal(pool.released, 1);
    strict.equal(pool.closed, 1);
  });
  await it("does not mistake conservative DMF nullability for a runtime NULL guarantee", async () => {
    const pool = new ServiceHarness();
    pool.columns = [
      {
        is_hidden: 0,
        column_ordinal: 1,
        name: "total",
        system_type_name: "bigint",
        is_nullable: 1,
        collation_name: null,
      },
    ];
    const verifier = createSqlServerLiveVerifier({ pool });
    const native = await verifier.verify({
      fingerprint,
      sql: "SELECT COUNT_BIG(*) AS total FROM dbo.widgets",
      operation: "read",
    });
    strict.equal(Object.hasOwn(native.columns[0]!, "nullable"), false);
    const dialect = sqlserver(),
      schema = maturitySnapshot(),
      rootDir = "/native-count",
      projects = [`${rootDir}/tsconfig.json`],
      sources = [
        {
          file: `${rootDir}/query.ts`,
          source:
            'import { sql } from "@typed-sql/sqlserver"; export const query=sql`SELECT COUNT_BIG(*) AS total FROM dbo.widgets`;',
        },
      ];
    const manifest = buildQueryManifest({
      rootDir,
      projects,
      sources,
      dialect,
      schema,
      compilerVersion: "native-count-test",
    }).manifest;
    const candidates = collectQueryVerificationCandidates({ manifest, rootDir, projects, sources, dialect, schema });
    const proof = await verifyQueryManifest({ manifest, candidates, verifier });
    strict.equal(proof.verified, 1);
    strict.equal(proof.mismatched, 0);
    await verifier.close();
  });
  await it("retains pre-order operators and safely decodes native identifier entities", () => {
    const nested = showplan.replace(
      /<RelOp\b[\s\S]*<\/RelOp>/u,
      '<RelOp PhysicalOp="Nested Loops"><NestedLoops><RelOp PhysicalOp="Index Seek"><IndexScan><Object Schema="[dbo]" Table="[widgets]" Index="[IX_widgets]"/></IndexScan></RelOp><RelOp PhysicalOp="Table Scan"><TableScan><Object Schema="[d&amp;b]" Table="[Order]]History]"/></TableScan></RelOp></NestedLoops></RelOp>',
    );
    const result = normalizeSqlServerShowplan(nested);
    strict.deepEqual(
      result.nodes.map((node) => node.kind),
      ["Nested Loops", "Index Seek", "Table Scan"],
    );
    strict.equal(result.nodes[2]?.relation, "d&b.Order]History");
    strict.ok(Object.isFrozen(result) && Object.isFrozen(result.nodes) && Object.isFrozen(result.nodes[0]));
    strict.throws(() => normalizeSqlServerShowplan(showplan.replace("recognizable-secret", "\u0000")));
    strict.throws(() => normalizeSqlServerShowplan(showplan.replace("recognizable-secret", "\ud800")));
  });
  await it("does not release an active session returned incorrectly by a pool twice", async () => {
    const harness = new ServiceHarness(),
      session = await harness.acquire();
    const original = harness.query.bind(harness);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.query = async (sql, values = []) => {
      if (sql === sqlServerVerificationQueries.columns) {
        started();
        await gate;
      }
      return original(sql, values);
    };
    const verifier = createSqlServerLiveVerifier({ pool: { acquire: async () => session } });
    const request = { fingerprint, sql: "SELECT amount FROM dbo.widgets", operation: "read" as const };
    const pending = verifier.verify(request);
    await entered;
    await strict.rejects(verifier.verify(request));
    await strict.rejects(verifier.verify(request));
    strict.equal(harness.released, 0);
    release();
    await pending;
    strict.equal(harness.released, 1);
    await verifier.close();
  });
});
