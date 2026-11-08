import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireNativeQueryContract,
  createNativeLiveAnalysisRunner,
  createPersistentLiveAnalysisRunner,
  createStaticQueryClaim,
  openAnalysisCache,
  parseQueryContract,
  queryContractDigest,
} from "@typed-sql/analysis";
import { describe, it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { duckDBContractReconciliationOwner } from "../src/contract-profile.js";
import { createNodeDuckDBNativeContractAdapter } from "../src/node-api-contracts.js";
import { duckDBParameterOccurrences } from "../src/parser/parser.js";
import { createDuckDBContractReconciler } from "../src/reconciliation.js";
import type { DuckDBSchemaSnapshot } from "../src/snapshot.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const schema: DuckDBSchemaSnapshot = { formatVersion: 1, dialect: "duckdb", tables: {} };
const options = { path: ":memory:", schema, sdkImporter: async () => sdk };
const candidate = (sql: string) => ({
  sql,
  parameterOccurrences: duckDBParameterOccurrences(sql).map(({ index, range }) => ({
    index,
    start: range.start,
    end: range.end,
  })),
});

await describe("DuckDB non-executing native query contracts", async () => {
  await it("acquires typed parameters and nested results using native prepare, with conservative nullability", async () => {
    const adapter = createNodeDuckDBNativeContractAdapter(options);
    const context = await adapter.inspectContext();
    const result = await acquireNativeQueryContract({
      adapter,
      context,
      candidate: candidate(
        "SELECT upper($1::VARCHAR) AS label, $2::DECIMAL(20,4) AS amount, [1::BIGINT,NULL] AS ids, {'x': 1::INTEGER} AS nested",
      ),
    });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw new Error("Native acquisition unavailable");
    const contract = parseQueryContract(JSON.parse(JSON.stringify(result.contract)));
    strict.equal(contract.origin, "native-description");
    strict.deepEqual(
      contract.valuePlan.parameters.map((item) => [item.databaseType, item.type, item.nullable]),
      [
        ["VARCHAR", "string", true],
        ["DECIMAL(20,4)", "string", true],
      ],
    );
    strict.deepEqual(
      contract.valuePlan.columns.map((item) => [item.name, item.databaseType, item.nullable]),
      [
        ["label", "VARCHAR", true],
        ["amount", "DECIMAL(20,4)", true],
        ["ids", "BIGINT[]", true],
        ["nested", 'STRUCT("x" INTEGER)', true],
      ],
    );
    strict.deepEqual(contract.valuePlan.columns[2]?.type, { array: "bigint", elementNullable: true });
    strict.deepEqual(contract.valuePlan.columns[3]?.type, { object: { x: { type: "number", nullable: true } } });
    strict.equal(contract.nativeEvidence?.consistency.mechanism, "snapshot");
    strict.equal(contract.nativeEvidence?.columns[0]?.nullable.status, "unknown");
  });

  await it("does not substitute values when native parameter inference is unavailable", async () => {
    const adapter = createNodeDuckDBNativeContractAdapter(options);
    const result = await acquireNativeQueryContract({
      adapter,
      context: await adapter.inspectContext(),
      candidate: candidate("SELECT $1+$2 AS value"),
    });
    strict.deepEqual(result, { status: "unavailable", reason: "parameter-metadata-unavailable" });
  });

  await it("preserves repeated parameter occurrences and applies the selected decoding policy", async () => {
    const adapter = createNodeDuckDBNativeContractAdapter({
      ...options,
      typePolicy: {
        bigint: "string",
        decimal: "string",
        temporal: "string",
        json: "string",
        enums: "string-union",
        unknown: "unknown",
      },
    });
    const result = await acquireNativeQueryContract({
      adapter,
      context: await adapter.inspectContext(),
      candidate: candidate("SELECT $1::BIGINT AS a, $1::BIGINT AS b"),
    });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw new Error("Native acquisition unavailable");
    strict.equal(result.contract.valuePlan.parameters.length, 1);
    strict.equal(result.contract.nativeEvidence?.parameterOccurrences.length, 2);
    strict.equal(result.contract.valuePlan.columns[0]?.type, "string");
  });

  await it("rejects unqualified statement classes and mismatched parameter layouts without opening the SDK", async () => {
    let imports = 0;
    const adapter = createNodeDuckDBNativeContractAdapter({
      ...options,
      sdkImporter: async () => {
        imports++;
        return sdk;
      },
    });
    for (const sql of [
      "SELECT * FROM read_csv('/tmp/private.csv')",
      "SELECT (SELECT 1) AS value",
      "SELECT * FROM t",
      "DELETE FROM t",
      "WITH t AS (SELECT 1) SELECT * FROM t",
      "SELECT system.main.upper('x')",
      "SELECT sum(1) OVER ()",
      "SELECT missing AS value",
      "SELECT CAST(1 AS unqualified_type)",
      "SELECT upper($named)",
      "SELECT ? AS value",
      "SELECT 1 LIMIT 1",
    ])
      strict.equal(adapter.accept(candidate(sql)).accepted, false, sql);
    strict.equal(adapter.accept({ sql: "SELECT $1::BIGINT", parameterOccurrences: [] }).accepted, false);
    strict.equal(imports, 0);
  });

  await it("does not describe macro, aggregate or side-effecting scalar families", async () => {
    const adapter = createNodeDuckDBNativeContractAdapter(options);
    const context = await adapter.inspectContext();
    for (const sql of [
      "SELECT nextval('counter') AS v",
      "SELECT sum(1) AS v",
      "SELECT error('candidate-must-not-run') AS v",
    ]) {
      await strict.rejects(
        acquireNativeQueryContract({ adapter, context, candidate: candidate(sql) }),
        /unsupported-statement/,
      );
    }
    const result = await acquireNativeQueryContract({ adapter, context, candidate: candidate("SELECT 1 AS v") });
    strict.equal(result.status, "acquired", "A rejected acquisition releases all native handles");
  });

  await it("binds contracts to policy/context and rejects cancellation before native loading", async () => {
    const adapter = createNodeDuckDBNativeContractAdapter(options);
    const context = await adapter.inspectContext();
    strict.deepEqual(
      await acquireNativeQueryContract({
        adapter,
        context: { ...context, databaseContextHash: "0".repeat(64) },
        candidate: candidate("SELECT 1 AS v"),
      }),
      { status: "unavailable", reason: "context-mismatch" },
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await strict.rejects(adapter.open(controller.signal), /native-failure/);
    strict.throws(() => createNodeDuckDBNativeContractAdapter({ ...options, path: "" }), /path/);
    strict.throws(() => createNodeDuckDBNativeContractAdapter({ ...options, statementTimeoutMs: 0 }), /timeout/);
    const lease = await adapter.open();
    await lease.close();
    await lease.close();
    await strict.rejects(lease.context(), /closed-session/);
    await strict.rejects(lease.describe(candidate("SELECT 1")), /closed-session/);
  });

  await it("sanitizes unavailable SDK/native errors and classifies them conservatively", async () => {
    const adapter = createNodeDuckDBNativeContractAdapter({
      ...options,
      sdkImporter: async () => {
        throw new Error("private-database-path");
      },
    });
    await strict.rejects(adapter.inspectContext(), (error: unknown) => {
      strict.equal(String(error).includes("private-database-path"), false);
      strict.deepEqual(adapter.classifyError?.(error), {
        kind: "unavailable",
        code: "duckdb-native-failure",
        retry: "change",
      });
      return true;
    });
  });

  await it("never binds or executes accepted SQL and releases every handle after cancellation during prepare", async () => {
    const sql = "SELECT sqrt($1::DOUBLE) AS value";
    const controller = new AbortController();
    const prepared: string[] = [];
    let destroyed = 0,
      connectionsClosed = 0,
      instancesClosed = 0,
      cancel = false;
    const observedSDK = {
      ...sdk,
      DuckDBInstance: new Proxy(sdk.DuckDBInstance, {
        get(target, key) {
          if (key !== "create") return Reflect.get(target, key);
          return async (path: string, configuration: Record<string, string>) => {
            strict.equal(configuration.enable_external_access, "false");
            strict.equal(configuration.autoload_known_extensions, "false");
            strict.equal(configuration.autoinstall_known_extensions, "false");
            const instance = await sdk.DuckDBInstance.create(path, configuration);
            return {
              async connect() {
                const connection = await instance.connect();
                return new Proxy(connection, {
                  get(target, key) {
                    if (key === "run")
                      return async (text: string) => {
                        strict.notEqual(text, sql, "Candidate SQL cannot use the executing path");
                        return target.run(text);
                      };
                    if (key === "prepare")
                      return async (text: string) => {
                        prepared.push(text);
                        const statement = await target.prepare(text);
                        if (cancel) controller.abort(new Error("cancel-during-prepare"));
                        return new Proxy(statement, {
                          get(handle, member) {
                            if (member === "destroySync")
                              return () => {
                                destroyed++;
                                handle.destroySync();
                              };
                            if (typeof member === "string" && /^(?:bind|run|stream)/u.test(member))
                              return () => {
                                throw new Error("Native contracts must not bind, run or stream candidate SQL");
                              };
                            const value = Reflect.get(handle, member);
                            return typeof value === "function" ? value.bind(handle) : value;
                          },
                        });
                      };
                    if (key === "closeSync")
                      return () => {
                        connectionsClosed++;
                        target.closeSync();
                      };
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                });
              },
              closeSync() {
                instancesClosed++;
                instance.closeSync();
              },
            };
          };
        },
      }),
    };
    const adapter = createNodeDuckDBNativeContractAdapter({ ...options, sdkImporter: async () => observedSDK });
    const context = await adapter.inspectContext();
    strict.equal(
      (await acquireNativeQueryContract({ adapter, context, candidate: candidate(sql) })).status,
      "acquired",
    );
    cancel = true;
    await strict.rejects(
      acquireNativeQueryContract({ adapter, context, candidate: candidate(sql), signal: controller.signal }),
      /cancel-during-prepare/,
    );
    strict.deepEqual(prepared, [sql, sql]);
    strict.equal(destroyed, 2);
    strict.equal(connectionsClosed, 3);
    strict.equal(instancesClosed, 3);
  });

  await it("opens existing files read-only, captures catalog drift and rejects case-insensitive macro shadowing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-duck-contract-"));
    const path = join(directory, "project.duckdb");
    const change = async (sql: string) => {
      const instance = await sdk.DuckDBInstance.create(path);
      const connection = await instance.connect();
      try {
        const result = await connection.run(sql);
        result.closeSync();
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    };
    try {
      await change("CREATE TABLE entries(id INTEGER)");
      const adapter = createNodeDuckDBNativeContractAdapter({ ...options, path });
      const before = await adapter.inspectContext();
      const sql = candidate("SELECT upper($1::VARCHAR) AS value");
      strict.equal((await acquireNativeQueryContract({ adapter, context: before, candidate: sql })).status, "acquired");
      await change("CREATE MACRO UPPER(input) AS 42");
      const after = await adapter.inspectContext();
      strict.notEqual(before.databaseContextHash, after.databaseContextHash);
      strict.deepEqual(await acquireNativeQueryContract({ adapter, context: before, candidate: sql }), {
        status: "unavailable",
        reason: "context-mismatch",
      });
      await strict.rejects(
        acquireNativeQueryContract({ adapter, context: after, candidate: sql }),
        /unsupported-statement/,
      );
      await strict.rejects(
        createNodeDuckDBNativeContractAdapter({ ...options, path: join(directory, "missing.duckdb") }).inspectContext(),
        /native-failure/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("regenerates unsupported routine results, records them offline and rejects an incorrect successful static claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-duck-live-"));
    const snapshot: DuckDBSchemaSnapshot = { ...schema, server: fixtureEvidence(sdk.version()) };
    let imports = 0;
    const adapter = createNodeDuckDBNativeContractAdapter({
      ...options,
      schema: snapshot,
      sdkImporter: async () => {
        imports++;
        return sdk;
      },
    });
    const context = await adapter.inspectContext();
    const grammar = duckdb();
    const owner = createDuckDBContractReconciler();
    const policy = { mode: "hybrid" as const, owner: duckDBContractReconciliationOwner, requiredNativeFacets: [] };
    const requestFor = (sql: string) => ({
      connectionContext: queryContractDigest("duckdb-local-test"),
      adapter: { id: adapter.id, version: adapter.version },
      candidate: candidate(sql),
      staticClaim: createStaticQueryClaim({ sql, context, analysis: grammar.analyze(sql, snapshot) }),
      policy,
    });
    const recordedQuery = (request: ReturnType<typeof requestFor>) => {
      const { staticClaim: _claim, ...recorded } = request;
      return { ...recorded, context };
    };
    try {
      const cache = await openAnalysisCache({
        directory,
        workspaceContext: queryContractDigest("duckdb-test-project"),
      });
      const run = createPersistentLiveAnalysisRunner({
        cache,
        run: createNativeLiveAnalysisRunner({ adapter, contribution: owner }),
      });
      const request = requestFor(`SELECT json_transform('{}', '{"x":"INTEGER"}') AS value`);
      strict.deepEqual(
        request.staticClaim.diagnostics.map((item) => item.code),
        ["TSQ408"],
      );
      const outcome = await run(request, new AbortController().signal);
      strict.equal(outcome.kind, "usable-recorded-context");
      if (outcome.kind !== "usable-recorded-context") throw new Error("Native result was not qualified");
      strict.deepEqual(outcome.contract.valuePlan.columns[0]?.type, {
        object: { x: { type: "number", nullable: true } },
      });
      const count = imports;
      const recorded = await cache.lookupRecorded(recordedQuery(request));
      strict.equal(recorded.cached?.outcome.kind, "usable-recorded-context");
      strict.equal(imports, count, "Recorded reuse does not load or contact the SDK");
      const changed = requestFor(`SELECT json_transform('{}', '{"x":"VARCHAR"}') AS value`);
      strict.equal((await cache.lookupRecorded(recordedQuery(changed))).cached, undefined);
      const refreshed = await run(changed, new AbortController().signal);
      strict.equal(refreshed.kind, "usable-recorded-context");
      if (refreshed.kind === "usable-recorded-context")
        strict.deepEqual(refreshed.contract.valuePlan.columns[0]?.type, {
          object: { x: { type: "string", nullable: true } },
        });
      const sql = "SELECT upper($1::VARCHAR) AS value";
      const correct = requestFor(sql);
      strict.equal((await run(correct, new AbortController().signal)).kind, "usable-recorded-context");
      const analysis = grammar.analyze(sql, snapshot);
      const wrong = {
        ...correct,
        staticClaim: createStaticQueryClaim({
          sql,
          context,
          analysis: {
            ...analysis,
            columns: analysis.columns.map((column) => ({
              ...column,
              tsType: "number",
              databaseType: "INTEGER",
              runtimeType: "number" as const,
            })),
          },
        }),
      };
      strict.equal((await run(wrong, new AbortController().signal)).kind, "conflict");
      strict.equal((await cache.lookupRecorded(recordedQuery(correct))).cached?.outcome.kind, "conflict");
      strict.equal((await run(correct, new AbortController().signal)).kind, "usable-recorded-context");
      const invalid = requestFor("SELECT upper(1,2) AS value");
      strict.ok(invalid.staticClaim.diagnostics.some((item) => item.code !== "TSQ408"));
      strict.equal(owner.classify(invalid.staticClaim).status, "invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
