import { acquireNativeQueryContract, canonicalContractData } from "@typed-sql/analysis";
import { upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
import type * as Driver from "mysql2/promise";
import { describe, it, strict } from "poku";
import { mySqlServerEvidence } from "../src/capabilities.js";
import { createMySql2NativeContractAdapter } from "../src/mysql2-contracts.js";
import { tokenize } from "../src/parser/index.js";
import type { MySqlSchemaSnapshot } from "../src/profile.js";
import { MYSQL_DIALECT_VERSION } from "../src/version.js";

const schema = upgradeSchemaSnapshotV1({
  formatVersion: 1,
  dialect: "mysql",
  dialectVersion: MYSQL_DIALECT_VERSION,
  version: "8.4.11",
  tables: {},
  server: mySqlServerEvidence("8.4.11", { versionComment: "MySQL Community Server - GPL", sqlMode: "" }),
}) as MySqlSchemaSnapshot;
const candidate = (sql: string) => ({
  sql,
  parameterOccurrences: tokenize(sql)
    .filter((t) => t.kind === "parameter")
    .map((t) => ({ index: Number(t.value), start: t.range.start, end: t.range.end })),
});
const column = { name: "value", columnType: 3, columnLength: 1, decimals: 0, characterSet: 63, flags: 1 };
function fixture(
  options: {
    routines?: unknown[];
    udfs?: unknown[];
    columns?: unknown[];
    parameters?: unknown[];
    stall?: boolean;
    metadataMissing?: boolean;
    deadline?: number;
    prepareError?: unknown;
    closeError?: unknown;
  } = {},
) {
  const calls: string[] = [];
  let imports = 0,
    releasePending: undefined | (() => void);
  const driverImporter = async () => {
    imports++;
    return {
      createConnection: async () => ({
        query: async (sql: string) => {
          calls.push(sql);
          if (sql === "ROLLBACK" && options.closeError) throw options.closeError;
          if (sql.includes("VERSION()"))
            return [
              [
                {
                  version: "8.4.11",
                  edition: "MySQL Community Server - GPL",
                  server: "server",
                  sqlMode: "",
                  db: "app",
                  principal: "app@localhost",
                },
              ],
            ];
          if (sql.includes("information_schema.ROUTINES")) return [options.routines ?? []];
          if (sql.includes("performance_schema.user_defined_functions")) return [options.udfs ?? []];
          if (sql.includes("performance_schema.")) return [[{ VARIABLE_NAME: "sql_mode", VARIABLE_VALUE: "" }]];
          if (
            !/^(SET SESSION lock_wait_timeout=|LOCK INSTANCE FOR BACKUP|START TRANSACTION READ ONLY|ROLLBACK|UNLOCK INSTANCE)/u.test(
              sql,
            )
          )
            throw new Error("Application SQL was sent through execution");
          return [[]];
        },
        prepare: async (sql: string) => {
          calls.push(`PREPARE ${sql}`);
          if (options.prepareError) throw options.prepareError;
          if (options.stall)
            await new Promise((_resolve, reject) => {
              releasePending = () => reject(new Error("private query and credentials"));
            });
          return {
            statement: options.metadataMissing
              ? undefined
              : { columns: options.columns ?? [column], parameters: options.parameters ?? [] },
            close: async () => {
              calls.push("CLOSE");
            },
          };
        },
        execute: () => {
          throw new Error("Application SQL must not execute");
        },
        end: async () => {
          calls.push("END");
        },
        destroy: () => {
          calls.push("DESTROY");
          releasePending?.();
        },
      }),
    } as unknown as typeof Driver;
  };
  return {
    calls,
    imports: () => imports,
    adapter: createMySql2NativeContractAdapter({
      schema,
      connectionUri: "mysql://private",
      driverImporter,
      statementTimeoutMs: options.deadline ?? 1000,
    }),
  };
}
await describe("MySQL owned native contracts", async () => {
  await it("rejects unqualified shapes and parameter layouts before loading the driver", async () => {
    const f = fixture();
    for (const sql of [
      "SELECT * FROM users",
      "SELECT (SELECT 1)",
      "SELECT app.f()",
      "SELECT K()",
      "SELECT @value",
      "SELECT 1 WHERE TRUE",
      "SELECT 1 UNION SELECT 2",
      "SELECT SUM(1) OVER ()",
      "SELECT 1 /*! INTO OUTFILE 'x' */",
      "SELECT 1; DROP TABLE users",
    ])
      strict.equal(f.adapter.accept({ sql, parameterOccurrences: [] }).accepted, false, sql);
    strict.equal(f.adapter.accept({ ...candidate("SELECT ?"), parameterOccurrences: [] }).accepted, false);
    strict.equal(f.imports(), 0);
    const controller = new AbortController();
    controller.abort();
    await strict.rejects(f.adapter.open(controller.signal));
    strict.equal(f.imports(), 0);
  });
  await it("acquires independent metadata and releases its backup lock without executing the candidate", async () => {
    const f = fixture();
    const context = await f.adapter.inspectContext();
    strict.equal(canonicalContractData(context), canonicalContractData(await f.adapter.inspectContext()));
    const result = await acquireNativeQueryContract({
      adapter: f.adapter,
      context,
      candidate: candidate("SELECT 1 AS value"),
    });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw new Error("Expected a contract");
    strict.deepEqual(result.contract.valuePlan.columns, [
      { name: "value", databaseType: "int", type: "number", nullable: false },
    ]);
    strict.equal(f.calls.filter((c) => c === "PREPARE SELECT 1 AS value").length, 1);
    strict.equal(f.calls.filter((c) => c === "UNLOCK INSTANCE").length, 3);
    strict.equal(f.calls.filter((c) => c === "END").length, 3);
  });
  await it("qualifies only independently bounded integer literals over BIGINT transport", async () => {
    const f = fixture({ columns: [{ ...column, columnType: 8, columnLength: 21, flags: 128 }] });
    const context = await f.adapter.inspectContext();
    for (const [text, type] of [
      ["1", "number"],
      ["-1", "number"],
      ["2147483647", "number"],
      ["2147483648", "bigint"],
      ["-2147483648", "bigint"],
      ["ABS(1)", "bigint"],
    ]) {
      const value = await acquireNativeQueryContract({
        adapter: f.adapter,
        context,
        candidate: candidate(`SELECT ${text} AS value`),
      });
      if (value.status !== "acquired") throw new Error("Expected native literal evidence");
      strict.equal(value.contract.valuePlan.columns[0]?.type, type, text);
    }
  });
  await it("does not let cleanup failures hide native rejection or expose transport details", async () => {
    const context = await fixture().adapter.inspectContext();
    const rejected = fixture({
      prepareError: Object.assign(new Error("private SQL"), { code: "ER_SP_DOES_NOT_EXIST", errno: 1305 }),
      closeError: Object.assign(new Error("private endpoint"), { code: "ECONNRESET" }),
    });
    await strict.rejects(
      acquireNativeQueryContract({ adapter: rejected.adapter, context, candidate: candidate("SELECT missing()") }),
      (error) => {
        strict.deepEqual(rejected.adapter.classifyError?.(error), { kind: "rejected", code: "mysql-native-rejected" });
        return !String(error).includes("private");
      },
    );
    const offline = createMySql2NativeContractAdapter({
      schema,
      connectionUri: "mysql://private",
      driverImporter: async () => {
        throw Object.assign(new Error("private endpoint"), { code: "ECONNREFUSED" });
      },
    });
    await strict.rejects(offline.inspectContext(), (error) => {
      strict.deepEqual(offline.classifyError?.(error), {
        kind: "unavailable",
        code: "mysql-transport-unavailable",
        retry: "transport",
      });
      return !String(error).includes("private");
    });
  });
  await it("rejects stored-routine names under the lock and retains unavailable parameter evidence", async () => {
    const f = fixture({ routines: [{ ROUTINE_NAME: "CUSTOM_F" }] });
    await strict.rejects(
      acquireNativeQueryContract({
        adapter: f.adapter,
        context: await f.adapter.inspectContext(),
        candidate: candidate("SELECT custom_f()"),
      }),
      /unsupported-statement/,
    );
    strict.equal(
      f.calls.some((c) => c.startsWith("PREPARE")),
      false,
    );
    const missing = fixture({ parameters: [{ columnType: 999 }] });
    strict.deepEqual(
      await acquireNativeQueryContract({
        adapter: missing.adapter,
        context: await missing.adapter.inspectContext(),
        candidate: candidate("SELECT ? AS value"),
      }),
      { status: "unavailable", reason: "parameter-metadata-unavailable" },
    );
    const absent = fixture({ metadataMissing: true });
    await strict.rejects(
      acquireNativeQueryContract({
        adapter: absent.adapter,
        context: await absent.adapter.inspectContext(),
        candidate: candidate("SELECT 1 AS value"),
      }),
      /metadata-unavailable/,
    );
  });
  await it("uses native collation checks for non-ASCII routine and UDF aliases", async () => {
    for (const f of [
      fixture({ routines: [{ ROUTINE_NAME: "cústom_f" }] }),
      fixture({ udfs: [{ UDF_NAME: "cústom_f" }] }),
    ]) {
      await strict.rejects(
        acquireNativeQueryContract({
          adapter: f.adapter,
          context: await f.adapter.inspectContext(),
          candidate: candidate("SELECT custom_f()"),
        }),
        /unsupported-statement/,
      );
      strict.ok(f.calls.some((sql) => sql.includes("CONVERT(") && sql.includes("utf8mb3_general_ci")));
      strict.equal(
        f.calls.some((sql) => sql.startsWith("PREPARE")),
        false,
      );
    }
  });
  await it("bounds stalled preparation and destroys the owned connection on cancellation", async () => {
    const f = fixture({ stall: true, deadline: 30 });
    const context = await f.adapter.inspectContext();
    await strict.rejects(
      acquireNativeQueryContract({ adapter: f.adapter, context, candidate: candidate("SELECT 1 AS value") }),
      (error) => !String(error).includes("private"),
    );
    strict.ok(f.calls.includes("DESTROY"));
    const cancelled = fixture({ stall: true });
    const lease = await cancelled.adapter.open();
    const controller = new AbortController();
    const pending = lease.describe(candidate("SELECT 1 AS value"), controller.signal);
    controller.abort();
    await strict.rejects(pending);
    await lease.close();
    strict.ok(cancelled.calls.includes("DESTROY"));
  });
  await it("bounds initialization and destroys a connection returned after cancellation", async () => {
    const stalled = createMySql2NativeContractAdapter({
      schema,
      connectionUri: "mysql://private",
      statementTimeoutMs: 20,
      driverImporter: () => new Promise(() => {}),
    });
    await strict.rejects(stalled.open(), /native-failure/);
    let complete: ((value: unknown) => void) | undefined;
    let destroyed = 0;
    const controller = new AbortController();
    const late = createMySql2NativeContractAdapter({
      schema,
      connectionUri: "mysql://private",
      driverImporter: async () =>
        ({
          createConnection: () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
        }) as unknown as typeof Driver,
    });
    const pending = late.open(controller.signal);
    for (let i = 0; i < 10 && !complete; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    if (!complete) throw new Error("Connection creation was not reached");
    controller.abort();
    await strict.rejects(pending);
    complete({
      destroy: () => {
        destroyed++;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    strict.equal(destroyed, 1, "A late connection cannot escape cleanup or resume acquisition");
  });
  await it("sanitizes loader failures and rejects unsupported policies", async () => {
    const adapter = createMySql2NativeContractAdapter({
      schema,
      connectionUri: "mysql://private",
      driverImporter: async () => {
        throw new Error("private password");
      },
    });
    await strict.rejects(
      adapter.inspectContext(),
      (error) => String(error).includes("native-failure") && !String(error).includes("private"),
    );
    strict.throws(
      () => createMySql2NativeContractAdapter({ schema, connectionUri: "x", statementTimeoutMs: 0 }),
      /deadline/,
    );
  });
});
