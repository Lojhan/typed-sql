import { sql as querySql, withQueryValuePlan } from "@typed-sql/core";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { strict } from "poku";
import {
  acquireNativeQueryContract,
  createContractDialect,
  createStaticQueryClaim,
  parseContractQualificationPolicy,
  queryContractDigest,
  reconcileQueryContract,
} from "../../packages/analysis/src/index.js";
import { compileSource } from "../../packages/compiler/src/index.js";
import { mysql } from "../../packages/mysql/src/analysis.js";
import { createMySql2Database, mysql2 } from "../../packages/mysql/src/mysql2.js";
import { createMySql2NativeContractAdapter } from "../../packages/mysql/src/mysql2-contracts.js";
import { tokenize } from "../../packages/mysql/src/parser/index.js";
import { mysqlProfile } from "../../packages/mysql/src/profile.js";
import { createMySqlContractReconciler } from "../../packages/mysql/src/reconciliation.js";

/** Disposable real-engine proof of table admission, dictionary identity and offline consumption. */
export async function assertMySqlTableContracts(connectionUri: string): Promise<void> {
  const admin = await createConnection(connectionUri);
  const prefix = `typed_sql_tables_${process.pid}`;
  const items = `${prefix}_items`,
    counter = `${prefix}_calls`,
    fn = `${prefix}_fn`,
    view = `${prefix}_view`,
    memory = `${prefix}_memory`,
    generated = `${prefix}_generated`;
  const lockName = `${prefix}_lock`;
  const candidate = (sql: string) => ({
    sql,
    parameterOccurrences: tokenize(sql)
      .filter((token) => token.kind === "parameter")
      .map((token) => ({ index: Number(token.value), start: token.range.start, end: token.range.end })),
  });
  try {
    await admin.query(
      `CREATE TABLE ${items}(id BIGINT NOT NULL,created_at DATE NOT NULL DEFAULT (CURRENT_DATE),amount DECIMAL(12,2)) ENGINE=InnoDB`,
    );
    const [defaults] = await admin.query<RowDataPacket[]>(
      "SELECT EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='created_at'",
      [items],
    );
    strict.match(defaults[0]?.EXTRA, /DEFAULT_GENERATED/u, "Ordinary expression defaults must remain admissible");
    await admin.query(`INSERT INTO ${items} VALUES (9007199254740993,'2024-01-01',12.34)`);
    await admin.query(`CREATE TABLE ${counter}(count INT NOT NULL) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO ${counter} VALUES (0)`);
    await admin.query(
      `CREATE FUNCTION ${fn}() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE ${counter} SET count=count+1; RETURN 1; END`,
    );
    await admin.query(`CREATE VIEW ${view} AS SELECT ${fn}() AS value FROM ${items}`);
    await admin.query(`CREATE TABLE ${memory}(id BIGINT) ENGINE=MEMORY`);
    await admin.query(
      `CREATE TABLE ${generated}(id BIGINT,doubled BIGINT GENERATED ALWAYS AS (id * 2) VIRTUAL) ENGINE=InnoDB`,
    );
    const schema = await mysql2({ connectionUri }).introspect();
    const adapter = createMySql2NativeContractAdapter({ connectionUri, schema });
    const context = await adapter.inspectContext();
    for (const sql of [
      `SELECT id FROM ${items} WHERE id=?`,
      `SELECT a.id FROM ${items} a LEFT JOIN ${items} b ON a.id=b.id WHERE a.id=?`,
    ]) {
      const result = await acquireNativeQueryContract({ adapter, context, candidate: candidate(sql) });
      strict.equal(result.status, "acquired", sql);
      if (result.status !== "acquired") throw Error("Missing table contract");
      strict.equal(result.contract.valuePlan.columns[0]?.type, "bigint");
      if (sql.includes("?")) strict.equal(result.contract.valuePlan.parameters[0]?.type, "bigint");
    }
    const probe = await adapter.open();
    try {
      await probe.describe(candidate(`SELECT id FROM ${items} WHERE GET_LOCK('${lockName}',0)=1`));
      strict.equal(
        (await admin.query<RowDataPacket[]>("SELECT IS_FREE_LOCK(?) AS available", [lockName]))[0][0]?.available,
        1,
        "A candidate predicate must not acquire an advisory lock while the native session remains open",
      );
    } finally {
      await probe.close();
    }
    for (const table of [view, memory, generated])
      await strict.rejects(
        acquireNativeQueryContract({ adapter, context, candidate: candidate(`SELECT * FROM ${table}`) }),
        /unsupported-statement/u,
      );
    await strict.rejects(
      acquireNativeQueryContract({ adapter, context, candidate: candidate(`SELECT ${fn}() AS value FROM ${items}`) }),
      /unsupported-statement/u,
    );
    strict.equal(
      (await admin.query<RowDataPacket[]>(`SELECT count FROM ${counter}`))[0][0]?.count,
      0,
      "Preparing table queries must not execute stored functions",
    );
    const starSql = `SELECT *,1 AS bounded FROM ${items}`;
    const star = await acquireNativeQueryContract({ adapter, context, candidate: candidate(starSql) });
    strict.equal(star.status, "acquired");
    if (star.status !== "acquired") throw Error("Missing star contract");
    strict.deepEqual(
      star.contract.nativeEvidence?.columns.map((column) => column.name),
      ["id", "created_at", "amount", "bounded"],
    );
    strict.equal(star.contract.valuePlan.columns[0]?.type, "bigint");
    strict.deepEqual(star.contract.nativeEvidence?.columns[2]?.nativeType, {
      status: "known",
      value: { name: "decimal(12,2)", complete: true },
    });
    const database = await createMySql2Database({ connectionUri });
    try {
      const rows = await database.execute(
        withQueryValuePlan(
          querySql<{ id: bigint; bounded: number }>`${querySql.raw(starSql)}`,
          star.contract.valuePlan,
        ),
      );
      strict.equal(rows[0]?.id, 9007199254740993n, "Expanded stars must retain exact BIGINT decoding");
      strict.equal(rows[0]?.bounded, 1, "A trailing numeric literal retains its exact number bound");
    } finally {
      await database.close();
    }
    const stringPolicy = { ...mysqlProfile().defaultTypePolicy, bigint: "string" as const };
    const stringSchema = await mysql2({ connectionUri, typePolicy: stringPolicy }).introspect();
    const stringAdapter = createMySql2NativeContractAdapter({
      connectionUri,
      schema: stringSchema,
      typePolicy: stringPolicy,
    });
    const stringStar = await acquireNativeQueryContract({
      adapter: stringAdapter,
      context: await stringAdapter.inspectContext(),
      candidate: candidate(starSql),
    });
    if (stringStar.status !== "acquired") throw Error("Missing string-policy star contract");
    const stringDatabase = await createMySql2Database({ connectionUri, typePolicy: stringPolicy });
    try {
      const rows = await stringDatabase.execute(
        withQueryValuePlan(
          querySql<{ id: string; bounded: number }>`${querySql.raw(starSql)}`,
          stringStar.contract.valuePlan,
        ),
      );
      strict.equal(rows[0]?.id, "9007199254740993");
      strict.equal(rows[0]?.bounded, 1, "Number-bound literals must agree with the BIGINT string-policy transport");
    } finally {
      await stringDatabase.close();
    }
    const sql = `SELECT TO_SECONDS(created_at) AS value FROM ${items} WHERE id=?`;
    const result = await acquireNativeQueryContract({ adapter, context, candidate: candidate(sql) });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw Error("Missing reusable table contract");
    const contribution = createMySqlContractReconciler();
    const qualification = {
      mode: "native-required" as const,
      owner: { id: contribution.id, version: contribution.version },
      requiredNativeFacets: ["runtime-type" as const],
    };
    strict.equal(
      reconcileQueryContract({
        nativeContract: star.contract,
        staticClaim: createStaticQueryClaim({ sql: starSql, context, analysis: mysql().analyze(starSql, schema) }),
        contribution,
        policy: qualification,
      }).status,
      "qualified",
      "Star contracts must reconcile without losing known trailing literal bounds",
    );
    const reconciled = reconcileQueryContract({
      nativeContract: result.contract,
      staticClaim: createStaticQueryClaim({ sql, context, analysis: mysql().analyze(sql, schema) }),
      contribution,
      policy: qualification,
    });
    strict.equal(reconciled.status, "qualified");
    if (reconciled.status !== "qualified") throw Error("Table contract failed reconciliation");
    const frozen = createContractDialect({
      profile: mysqlProfile(),
      context,
      contracts: [JSON.parse(JSON.stringify(reconciled.contract))],
      qualificationPolicyHash: queryContractDigest(parseContractQualificationPolicy(qualification)),
    });
    const source =
      'import {sql} from "@typed-sql/mysql"; export function query(value:bigint){return sql`' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: SQL interpolation is retained in application source.
      sql.replace("?", "${value}") +
      "`;}";
    const compiled = compileSource({ source, schema, dialect: frozen, runtimeMetadata: true });
    strict.deepEqual(compiled.diagnostics, []);
    strict.match(compiled.queries[0]!.rowType, /value.*bigint/u);
    await admin.query(`UPDATE ${items} SET amount=amount`);
    strict.equal(
      (await adapter.inspectContext()).databaseContextHash,
      context.databaseContextHash,
      "Ordinary DML must not invalidate dictionary identity",
    );
    const lease = await createMySql2NativeContractAdapter({ connectionUri, schema, statementTimeoutMs: 10000 }).open();
    try {
      await lease.describe(candidate(`SELECT id FROM ${items}`));
      await admin.query("SET SESSION lock_wait_timeout=1");
      await strict.rejects(
        admin.query(`ALTER TABLE ${items} ADD COLUMN extra INT`),
        (error: unknown) => (error as { code?: string }).code === "ER_LOCK_WAIT_TIMEOUT",
      );
    } finally {
      await lease.close();
    }
    await admin.query(`ALTER TABLE ${items} ADD COLUMN extra INT`);
    strict.notEqual(
      (await adapter.inspectContext()).databaseContextHash,
      context.databaseContextHash,
      "Table DDL must retire the old dictionary context even with the same supplied schema",
    );
  } finally {
    await admin.query("SELECT RELEASE_LOCK(?)", [lockName]);
    for (const sql of [
      `DROP VIEW IF EXISTS ${view}`,
      `DROP FUNCTION IF EXISTS ${fn}`,
      ...[generated, memory, counter, items].map((table) => `DROP TABLE IF EXISTS ${table}`),
    ])
      await admin.query(sql);
    await admin.end();
  }
}
