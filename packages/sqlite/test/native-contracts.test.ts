import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  acquireNativeQueryContract,
  createStaticQueryClaim,
  type NativeContractCandidate,
  type QueryContract,
  queryContractDigest,
  reconcileQueryContract,
} from "@typed-sql/analysis";
import { sql, withQueryValuePlan } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { sqlite } from "../src/analysis.js";
import {
  sqliteContractIdentity,
  sqliteContractPolicy,
  sqliteContractReconciliationOwner,
} from "../src/contract-profile.js";
import { createNodeSqliteDatabase } from "../src/node-sqlite.js";
import { createNodeSqliteNativeContractAdapter, SqliteContractAcquisitionError } from "../src/node-sqlite-contracts.js";
import { sqliteProfile } from "../src/profile.js";
import { createSqliteContractReconciler } from "../src/reconciliation.js";
import { defaultSqliteTypePolicy } from "../src/type-policy.js";

const schema = { formatVersion: 1 as const, dialect: "sqlite" as const, tables: {} };
const candidate = (sql: string): NativeContractCandidate => ({
  sql,
  parameterOccurrences: sqliteProfile().parameterOccurrences!(sql, schema).map(({ index, range }) => ({
    index,
    start: range.start,
    end: range.end,
  })),
});
async function temporary(run: (path: string, database: DatabaseSync) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-contract-"));
  const path = join(directory, "fixture.sqlite");
  const database = new DatabaseSync(path);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE values_table (value TEXT) STRICT; INSERT INTO values_table VALUES ('hello'); CREATE TABLE calls (value INTEGER) STRICT; INSERT INTO calls VALUES(0)",
  );
  try {
    await run(path, database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function acquire(path: string, sql: string): Promise<QueryContract> {
  const adapter = createNodeSqliteNativeContractAdapter({ path, schema });
  const result = await acquireNativeQueryContract({
    adapter,
    context: await adapter.inspectContext(),
    candidate: candidate(sql),
  });
  strict.equal(result.status, "acquired");
  if (result.status !== "acquired") throw Error("Expected acquired query contract");
  return result.contract;
}

await describe("SQLite owned read-only native query contracts", async () => {
  const probe = new DatabaseSync(":memory:");
  const statement = probe.prepare("SELECT 1");
  const supported = typeof probe.setAuthorizer === "function" && typeof statement.columns === "function";
  if ("close" in statement && typeof statement.close === "function") statement.close();
  probe.close();
  if (!supported) {
    await it("reports the unavailable native profile on runtimes without the required metadata guards", async () => {
      await temporary(async (path) => {
        await strict.rejects(
          createNodeSqliteNativeContractAdapter({ path, schema }).inspectContext(),
          /unsupported-context|native-failure/u,
        );
      });
    });
    await it.skip("Native SQLite qualification requires the authorizer and column-metadata APIs", () => {});
    return;
  }
  await it("executes the recorded storage domains through the same integer and binding policy", async () => {
    await temporary(async (path) => {
      for (const integer of ["bigint", "number"] as const) {
        const policy = { ...defaultSqliteTypePolicy, integer };
        const adapter = createNodeSqliteNativeContractAdapter({ path, schema, typePolicy: policy });
        const text =
          "SELECT ? AS integer_value, ? AS text_value, ? AS bytes_value, ? AS boolean_value, ? AS null_value, ? AS real_value";
        const result = await acquireNativeQueryContract({
          adapter,
          context: await adapter.inspectContext(),
          candidate: candidate(text),
        });
        if (result.status !== "acquired") throw Error("Expected acquired storage-domain contract");
        const database = await createNodeSqliteDatabase({ path, typePolicy: policy });
        const input = integer === "bigint" ? 7n : 7;
        try {
          const query = withQueryValuePlan(
            sql`SELECT ${input} AS integer_value, ${"text"} AS text_value, ${new Uint8Array([1, 2])} AS bytes_value, ${true} AS boolean_value, ${null} AS null_value, ${1.5} AS real_value`,
            result.contract.valuePlan,
          );
          strict.deepEqual(await database.one(query), {
            integer_value: input,
            text_value: "text",
            bytes_value: new Uint8Array([1, 2]),
            boolean_value: integer === "bigint" ? 1n : 1,
            null_value: null,
            real_value: 1.5,
          });
        } finally {
          await database.close();
        }
      }
    });
  });
  await it("qualifies joins, CTEs, compounds, builtins and parameters without sampling storage types", async () => {
    await temporary(async (path) => {
      for (const sql of [
        "SELECT value FROM values_table UNION ALL SELECT 42",
        "WITH selected AS (SELECT value FROM values_table) SELECT a.value AS first, b.value AS second FROM selected a LEFT JOIN values_table b ON a.value=b.value",
        "SELECT concat('hello', 'world') AS result, json_object('x',1) AS document",
        "SELECT ? AS first, ? AS second",
        "VALUES (1, 'text'), (2, NULL)",
      ]) {
        const contract = await acquire(path, sql);
        strict.equal(contract.origin, "native-description");
        strict.equal(contract.nativeEvidence?.consistency.mechanism, "snapshot");
        strict.ok(contract.valuePlan.columns.every((column) => column.nullable));
        strict.ok(
          contract.valuePlan.columns.every((column) => typeof column.type === "object" && "union" in column.type),
        );
        strict.ok(
          contract.nativeEvidence?.columns.every(
            (column) => column.nativeType.status === "known" && !column.nativeType.value.complete,
          ),
        );
        strict.equal(contract.valuePlan.parameters.length, candidate(sql).parameterOccurrences.length);
      }
      const compound = await acquire(path, "SELECT value FROM values_table UNION ALL SELECT 42");
      const origin = compound.nativeEvidence!.columns[0]!.descriptor.origin as { type: string };
      strict.equal(origin.type, "TEXT");
      strict.deepEqual(compound.valuePlan.columns[0]!.type, { union: ["bigint", "number", "string", "bytes"] });
    });
  });
  await it("prepares a query whose evaluation would fail, and rejects writes, external access and unregistered routines", async () => {
    await temporary(async (path, database) => {
      const sql = "SELECT randomblob(1000000000000) AS value";
      strict.throws(() => database.prepare(sql).get(), /too big/u);
      strict.equal((await acquire(path, sql)).valuePlan.columns[0]!.name, "value");
      let calls = 0;
      database.function("local_side_effect", () => ++calls);
      const adapter = createNodeSqliteNativeContractAdapter({ path, schema });
      for (const text of [
        "WITH selected AS (SELECT 1) DELETE FROM calls RETURNING value",
        "SELECT load_extension('never-load-this') AS value",
        "SELECT local_side_effect() AS value",
        "SELECT * FROM pragma_table_info('values_table')",
      ]) {
        const session = await adapter.open();
        try {
          await strict.rejects(session.describe(candidate(text)), SqliteContractAcquisitionError);
        } finally {
          await session.close();
        }
      }
      strict.equal(calls, 0);
      strict.equal(database.prepare("SELECT value FROM calls").get()!.value, 0);
    });
  });
  await it("declines extra statements and mismatched or non-anonymous bindings before opening native work", () => {
    const adapter = createNodeSqliteNativeContractAdapter({ path: "/not-opened.sqlite", schema });
    for (const sql of [
      "SELECT 1; SELECT 2",
      "SELECT 1;;",
      "PRAGMA journal_mode",
      "DELETE FROM calls",
      "SELECT ?12",
      "SELECT $1",
      "SELECT :name",
      "SELECT @name",
    ]) {
      strict.equal(adapter.accept({ sql, parameterOccurrences: [] }).accepted, false, sql);
    }
    strict.equal(adapter.accept({ sql: "SELECT ? AS value", parameterOccurrences: [] }).accepted, false);
    strict.equal(adapter.accept(candidate("SELECT '?' AS value; -- ? is not a parameter")).accepted, true);
    strict.equal(adapter.accept(candidate("SELECT ? AS value, '?' AS literal")).accepted, true);
    strict.equal(
      adapter.accept({ sql: "SELECT ? AS value", parameterOccurrences: [{ index: 1, start: 0, end: 1 }] }).accepted,
      false,
    );
  });
  await it("holds a schema snapshot for a lease, detects later schema drift, and disposes cancelled work", async () => {
    await temporary(async (path, database) => {
      const adapter = createNodeSqliteNativeContractAdapter({ path, schema });
      const before = await adapter.inspectContext();
      const session = await adapter.open();
      database.exec("CREATE TABLE newer (value INTEGER) STRICT");
      strict.deepEqual(await session.context(), before);
      await session.describe(candidate("SELECT value FROM values_table"));
      await strict.rejects(session.describe(candidate("SELECT 1 AS value")), /unsupported-context/u);
      await session.close();
      await session.close();
      await strict.rejects(session.context(), /closed-session/u);
      const after = await adapter.inspectContext();
      strict.notEqual(before.databaseContextHash, after.databaseContextHash);
      strict.deepEqual(
        await acquireNativeQueryContract({ adapter, context: before, candidate: candidate("SELECT 1 AS value") }),
        { status: "unavailable", reason: "context-mismatch" },
      );
      const aborted = new AbortController();
      aborted.abort(Error("cancelled"));
      await strict.rejects(adapter.open(aborted.signal), /cancelled/u);
      await strict.rejects(
        createNodeSqliteNativeContractAdapter({ path, schema, statementTimeoutMs: 1 }).inspectContext(),
        /deadline/u,
      );
      const controller = new AbortController();
      const opening = adapter.open(controller.signal);
      const rejected = strict.rejects(opening, /cancelled/u);
      controller.abort(Error("cancelled"));
      await rejected;
      database.exec("CREATE TABLE after_cancel (value INTEGER) STRICT");
      strict.ok((await adapter.inspectContext()).databaseContextHash);
    });
  });
  await it("does not inherit application preloads or module search overrides into the native process", async () => {
    await temporary(async (path) => {
      const beforeOptions = process.env.NODE_OPTIONS,
        beforePath = process.env.NODE_PATH;
      process.env.NODE_OPTIONS = "--require=/typed-sql-preload-must-not-run.cjs";
      process.env.NODE_PATH = "/typed-sql-module-override-must-not-apply";
      try {
        strict.ok((await createNodeSqliteNativeContractAdapter({ path, schema }).inspectContext()).databaseContextHash);
      } finally {
        if (beforeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = beforeOptions;
        if (beforePath === undefined) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = beforePath;
      }
    });
  });
  await it("rejects virtual-table contexts and invalid registration without borrowing caller connections", async () => {
    await temporary(async (path, database) => {
      database.exec("CREATE VIRTUAL TABLE search USING fts5(body)");
      const adapter = createNodeSqliteNativeContractAdapter({ path, schema });
      await strict.rejects(adapter.inspectContext(), /unsupported-context/u);
      strict.deepEqual(adapter.classifyError!(new SqliteContractAcquisitionError("unsupported-context")), {
        kind: "unavailable",
        code: "sqlite-native-profile-unavailable",
        retry: "change",
      });
      strict.equal(adapter.classifyError!(new SqliteContractAcquisitionError("native-rejected")).kind, "rejected");
      strict.equal(adapter.classifyError!(Error("do not retain this error")).kind, "unavailable");
    });
    for (const path of ["", ":memory:", "file:shared.sqlite", "bad\0path"])
      strict.throws(() => createNodeSqliteNativeContractAdapter({ path, schema }), /file/u);
    strict.throws(
      () => createNodeSqliteNativeContractAdapter({ path: "unused", schema, statementTimeoutMs: 0 }),
      /deadline/u,
    );
    strict.throws(
      () => sqliteContractPolicy({ ...defaultSqliteTypePolicy, integer: "invalid" as "number" }),
      /policy/u,
    );
    strict.notDeepEqual(
      sqliteContractIdentity(),
      sqliteContractIdentity({ ...defaultSqliteTypePolicy, integer: "number" }),
    );
  });
  await it("reconciles independent claims with broad native bounds and refuses unsupported precision requirements", async () => {
    await temporary(async (path) => {
      const sql = "SELECT 1 AS value";
      const contract = await acquire(path, sql);
      const analysis = sqlite().analyze(sql, schema);
      const claim = createStaticQueryClaim({ sql, context: contract.context, analysis });
      const qualification = {
        mode: "native-required" as const,
        owner: sqliteContractReconciliationOwner,
        requiredNativeFacets: ["runtime-type" as const],
      };
      const result = reconcileQueryContract({
        nativeContract: contract,
        staticClaim: claim,
        contribution: createSqliteContractReconciler(),
        policy: qualification,
      });
      strict.equal(result.status, "qualified");
      if (result.status === "qualified") strict.deepEqual(result.contract.valuePlan, contract.valuePlan);
      const builtinSql = "SELECT concat('hello', 'world') AS value";
      const builtin = await acquire(path, builtinSql);
      const builtinAnalysis = sqlite().analyze(builtinSql, schema);
      strict.ok(builtinAnalysis.diagnostics.some(({ code }) => code === "TSQ402"));
      strict.equal(
        reconcileQueryContract({
          nativeContract: builtin,
          staticClaim: createStaticQueryClaim({ sql: builtinSql, context: builtin.context, analysis: builtinAnalysis }),
          contribution: createSqliteContractReconciler(),
          policy: qualification,
        }).status,
        "qualified",
      );
      for (const statement of ["VALUES (1), (2)", "SELECT 'hello' LIKE 'h%' ESCAPE '!' AS value"]) {
        const nativeContract = await acquire(path, statement);
        const analysis = sqlite().analyze(statement, schema);
        strict.ok(analysis.diagnostics.some(({ code }) => code === "TSQ001"));
        strict.equal(
          reconcileQueryContract({
            nativeContract,
            staticClaim: createStaticQueryClaim({ sql: statement, context: nativeContract.context, analysis }),
            contribution: createSqliteContractReconciler(),
            policy: qualification,
          }).status,
          "qualified",
        );
      }
      await strict.rejects(acquire(path, "SELECT FROM values_table"), /native-rejected/u);
      strict.equal(
        reconcileQueryContract({
          nativeContract: contract,
          staticClaim: claim,
          contribution: createSqliteContractReconciler(),
          policy: { ...qualification, requiredNativeFacets: ["native-type"] },
        }).status,
        "incomplete",
      );
      const { digest: _, ...body } = claim;
      const wrong = {
        ...body,
        columns: body.columns.map((column) => ({ ...column, tsType: "Date", runtimeType: "date" as const })),
      };
      strict.equal(
        reconcileQueryContract({
          nativeContract: contract,
          staticClaim: { ...wrong, digest: queryContractDigest(wrong) },
          contribution: createSqliteContractReconciler(),
          policy: qualification,
        }).status,
        "conflict",
      );
      const unknown = createNodeSqliteNativeContractAdapter({
        path,
        schema,
        typePolicy: { ...defaultSqliteTypePolicy, flexible: "unknown" },
      });
      const unavailable = await acquireNativeQueryContract({
        adapter: unknown,
        context: await unknown.inspectContext(),
        candidate: candidate("SELECT ? AS value"),
      });
      strict.equal(unavailable.status, "unavailable");
      if (unavailable.status === "unavailable") strict.equal(unavailable.reason, "parameter-metadata-unavailable");
    });
  });
});
