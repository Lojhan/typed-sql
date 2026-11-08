import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql as querySql, withQueryValuePlan } from "@typed-sql/core";
import { createConnection } from "mysql2/promise";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  createContractDialect,
  createNativeLiveAnalysisRunner,
  createPersistentLiveAnalysisRunner,
  createStaticQueryClaim,
  exportQueryContracts,
  loadQueryContracts,
  openAnalysisCache,
  queryContractDigest,
} from "../../packages/analysis/src/index.js";
import { compileSource } from "../../packages/compiler/src/index.js";
import { mysql } from "../../packages/mysql/src/analysis.js";
import { mySqlContractReconciliationOwner } from "../../packages/mysql/src/contract-profile.js";
import { createMySql2Database, mysql2 } from "../../packages/mysql/src/mysql2.js";
import { createMySql2NativeContractAdapter } from "../../packages/mysql/src/mysql2-contracts.js";
import { tokenize } from "../../packages/mysql/src/parser/index.js";
import { mysqlProfile } from "../../packages/mysql/src/profile.js";
import { createMySqlContractReconciler } from "../../packages/mysql/src/reconciliation.js";
import { assertMySqlTableContracts } from "./mysql-table-contracts.js";

/** Requires a disposable qualification database and BACKUP_ADMIN plus metadata privileges. */
export async function assertMySqlNativeContracts(connectionUri: string): Promise<void> {
  const admin = await createConnection(connectionUri);
  const prefix = `typed_sql_native_${process.pid}`;
  const table = `${prefix}_calls`,
    fn = `${prefix}_function`,
    accent = `${prefix}_é`,
    view = `${prefix}_view`;
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-mysql-native-"));
  const candidate = (sql: string) => ({
    sql,
    parameterOccurrences: tokenize(sql)
      .filter((t) => t.kind === "parameter")
      .map((t) => ({ index: Number(t.value), start: t.range.start, end: t.range.end })),
  });
  try {
    await admin.query(`CREATE TABLE ${table}(count INT NOT NULL)`);
    await admin.query(`INSERT INTO ${table} VALUES (0)`);
    await admin.query(`CREATE VIEW ${view} AS SELECT count FROM ${table}`);
    await admin.query(
      `CREATE FUNCTION ${fn}() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE ${table} SET count=count+1; RETURN 1; END`,
    );
    await admin.query(
      `CREATE FUNCTION \`${accent}\`() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE ${table} SET count=count+1; RETURN 1; END`,
    );
    const schema = await mysql2({ connectionUri }).introspect();
    if (schema.formatVersion !== 2) throw new Error("The native fixture requires a versioned schema");
    const adapter = createMySql2NativeContractAdapter({ connectionUri, schema });
    const context = await adapter.inspectContext();
    strict.deepEqual(
      await adapter.inspectContext(),
      context,
      "Fresh owned sessions must share semantic context identity",
    );
    const result = await acquireNativeQueryContract({
      adapter,
      context,
      candidate: candidate("SELECT CAST(? AS DECIMAL(12,3)) AS amount, TO_SECONDS('2024-01-01') AS seconds"),
    });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw new Error("Native MySQL evidence unavailable");
    strict.deepEqual(
      result.contract.valuePlan.columns.map((c) => [c.databaseType, c.type]),
      [
        ["decimal(12,3)", "string"],
        ["bigint", "bigint"],
      ],
    );
    strict.equal(result.contract.valuePlan.parameters[0]?.databaseType, "decimal(65,30)");
    strict.equal(result.contract.valuePlan.parameters[0]?.nullable, true);
    await strict.rejects(
      acquireNativeQueryContract({ adapter, context, candidate: candidate(`SELECT ${fn}() AS value`) }),
      /unsupported-statement/,
    );
    const alias = `SELECT ${prefix}_e() AS value`;
    const bound = await admin.prepare(alias);
    await bound.close();
    await strict.rejects(
      acquireNativeQueryContract({ adapter, context, candidate: candidate(alias) }),
      /unsupported-statement/,
    );
    const [counter] = await admin.query(`SELECT count FROM ${table}`);
    strict.deepEqual(counter, [{ count: 0 }], "Describing a project routine must never execute its body");
    const [installed] = await admin.query<Array<import("mysql2/promise").RowDataPacket>>(
      "SELECT UDF_NAME FROM performance_schema.user_defined_functions ORDER BY UDF_NAME LIMIT 1",
    );
    const udf = installed[0]?.UDF_NAME;
    if (typeof udf !== "string" || !/^[a-z_][a-z0-9_]*$/iu.test(udf))
      throw new Error("The qualified engine fixture needs an installed UDF");
    await strict.rejects(
      acquireNativeQueryContract({ adapter, context, candidate: candidate(`SELECT ${udf.toUpperCase()}() AS value`) }),
      /unsupported-statement/,
    );

    const lease = await createMySql2NativeContractAdapter({ connectionUri, schema, statementTimeoutMs: 10000 }).open();
    try {
      await admin.query("SET SESSION lock_wait_timeout=1");
      await admin.query(`UPDATE ${table} SET count=0`);
      for (const sql of [
        `DROP FUNCTION IF EXISTS \`${accent}\``,
        `ALTER TABLE ${table} ADD COLUMN extra INT`,
        `ALTER VIEW ${view} AS SELECT 1 AS count`,
        `ALTER FUNCTION ${fn} COMMENT 'changed'`,
        `DROP FUNCTION ${fn}`,
      ])
        await strict.rejects(
          admin.query(sql),
          (error: unknown) =>
            !!error && typeof error === "object" && "code" in error && error.code === "ER_LOCK_WAIT_TIMEOUT",
          sql,
        );
    } finally {
      await lease.close();
    }
    await admin.query(`ALTER TABLE ${table} ADD COLUMN extra INT`);
    const controller = new AbortController();
    const cancelled = await adapter.open(controller.signal);
    controller.abort();
    await cancelled.close();
    await admin.query(`ALTER TABLE ${table} DROP COLUMN extra`);
    const timed = createMySql2NativeContractAdapter({ connectionUri, schema, statementTimeoutMs: 150 });
    const expired = await timed.open();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expired.close();
    await admin.query(`ALTER VIEW ${view} AS SELECT count FROM ${table}`);

    const grammar = mysql();
    const owner = createMySqlContractReconciler();
    const cache = await openAnalysisCache({
      directory: join(directory, "cache"),
      workspaceContext: queryContractDigest("mysql-native-fixture"),
    });
    const policy = {
      mode: "native-required" as const,
      owner: mySqlContractReconciliationOwner,
      requiredNativeFacets: ["runtime-type" as const],
    };
    const requestFor = (sql: string) => ({
      connectionContext: queryContractDigest(connectionUri),
      adapter: { id: adapter.id, version: adapter.version },
      candidate: candidate(sql),
      staticClaim: createStaticQueryClaim({ sql, context, analysis: grammar.analyze(sql, schema) }),
      policy,
    });
    const run = createPersistentLiveAnalysisRunner({
      cache,
      run: createNativeLiveAnalysisRunner({ adapter, contribution: owner }),
    });
    const request = requestFor("SELECT TO_SECONDS('2024-01-01') AS value");
    strict.ok(
      request.staticClaim.diagnostics.some((item) => item.code === "TSQ202"),
      "The fixture must require native expansion",
    );
    const acquired = await run(request, new AbortController().signal);
    strict.equal(acquired.kind, "usable-recorded-context");
    if (acquired.kind !== "usable-recorded-context")
      throw new Error(`Native qualification failed: ${JSON.stringify(acquired)}`);
    strict.equal(acquired.contract.valuePlan.columns[0]?.type, "bigint");
    const { staticClaim: _claim, ...recorded } = request;
    strict.equal(
      (await cache.lookupRecorded({ ...recorded, context })).cached?.outcome.kind,
      "usable-recorded-context",
    );
    const changed = await run(requestFor("SELECT REVERSE('x') AS value"), new AbortController().signal);
    strict.equal(changed.kind, "usable-recorded-context");
    if (changed.kind !== "usable-recorded-context") throw new Error("Changed SQL was not regenerated");
    strict.equal(changed.contract.valuePlan.columns[0]?.type, "string");
    const geometrySql = "SELECT ST_GeomFromText('POINT(1 2)') AS value";
    const geometry = await run(requestFor(geometrySql), new AbortController().signal);
    strict.equal(geometry.kind, "usable-recorded-context");
    if (geometry.kind !== "usable-recorded-context") throw new Error("Geometry contract was not acquired");
    strict.equal(geometry.contract.valuePlan.columns[0]?.type, "bytes");
    const database = await createMySql2Database({ connectionUri });
    try {
      const query = withQueryValuePlan(
        querySql<{ value: Uint8Array }>`${querySql.raw(geometrySql)}`,
        geometry.contract.valuePlan,
      );
      const rows = await database.execute(query);
      strict.ok(rows[0]?.value instanceof Uint8Array);
      const value = rows[0]!.value;
      strict.equal(value.byteLength, 25);
      const point = new DataView(value.buffer, value.byteOffset, value.byteLength);
      strict.equal(point.getUint32(0, true), 0);
      strict.equal(point.getUint8(4), 1);
      strict.equal(point.getUint32(5, true), 1);
      strict.equal(point.getFloat64(9, true), 1);
      strict.equal(point.getFloat64(17, true), 2);
    } finally {
      await database.close();
    }
    const legacy = await run(requestFor("SELECT MD5('x') AS value"), new AbortController().signal);
    strict.equal(
      legacy.kind,
      schema.server.version === "9.7.2" ? "rejected" : "usable-recorded-context",
      "Native acquisition respects the actual engine's available functions",
    );
    if (schema.server.version === "9.7.2") {
      const vector = await run(requestFor("SELECT STRING_TO_VECTOR('[1,2,3]') AS value"), new AbortController().signal);
      strict.equal(vector.kind, "usable-recorded-context");
      if (vector.kind === "usable-recorded-context") strict.equal(vector.contract.valuePlan.columns[0]?.type, "bytes");
    }
    const sql = "SELECT 1 AS value";
    const correct = requestFor(sql);
    const analysis = grammar.analyze(sql, schema);
    const wrong = {
      ...correct,
      staticClaim: createStaticQueryClaim({
        sql,
        context,
        analysis: { ...analysis, columns: analysis.columns.map((c) => ({ ...c, tsType: "string" })) },
      }),
    };
    strict.equal(
      (await run(wrong, new AbortController().signal)).kind,
      "conflict",
      "Independent qualification must reject an incorrect successful offline claim",
    );
    strict.equal((await run(correct, new AbortController().signal)).kind, "usable-recorded-context");
    const contracts = join(directory, "contracts");
    await exportQueryContracts(contracts, [acquired.contract, changed.contract]);
    const frozen = createContractDialect({
      profile: mysqlProfile(),
      context,
      contracts: await loadQueryContracts(contracts),
    });
    const source =
      "import {sql} from '@typed-sql/mysql'; export const q=sql`SELECT TO_SECONDS('2024-01-01') AS value`;";
    const compiled = compileSource({ source, schema, dialect: frozen, runtimeMetadata: true });
    strict.deepEqual(compiled.diagnostics, []);
    strict.ok(compiled.queries[0]?.rowType.includes("bigint"));
    await admin.query(`DROP FUNCTION ${fn}`);
    const drifted = await adapter.inspectContext();
    strict.notEqual(drifted.databaseContextHash, context.databaseContextHash);
    await assertMySqlTableContracts(connectionUri);
  } finally {
    for (const sql of [
      `DROP VIEW IF EXISTS ${view}`,
      `DROP FUNCTION IF EXISTS \`${accent}\``,
      `DROP FUNCTION IF EXISTS ${fn}`,
      `DROP TABLE IF EXISTS ${table}`,
    ])
      await admin.query(sql);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
