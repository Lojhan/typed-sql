import { it, strict } from "poku";
import {
  createNodeDuckDBDatabase,
  createNodeDuckDBLiveVerifier,
  createNodeDuckDBPlanInspector,
} from "../src/node-api.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
const fingerprint = `sha256:${"a".repeat(64)}`;
await it(`native verification and non-executing plans on DuckDB ${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const database = await createNodeDuckDBDatabase({ connection, sdkImporter: async () => sdk });
  try {
    strict.equal((await database.queryable.all("SELECT version() AS version"))[0]?.version, `v${version}`);
    await database.queryable.all("CREATE TABLE secrets(id BIGINT NOT NULL, payload VARCHAR)");
    await database.queryable.all("INSERT INTO secrets VALUES(1,'PRIVATE_VALUE')");
    const verifier = database.liveVerifier;
    strict.equal((await verifier.server()).version, `v${version}`);
    const described = await verifier.verify({
      fingerprint,
      sql: "SELECT id,payload FROM secrets WHERE id=$1",
      operation: "read",
    });
    strict.deepEqual(described.columns, [
      { index: 1, name: "id", databaseType: "BIGINT", tsType: "bigint" },
      { index: 2, name: "payload", databaseType: "VARCHAR", tsType: "string" },
    ]);
    strict.deepEqual(described.parameters, [{ index: 1, databaseType: "BIGINT", tsType: "bigint" }]);
    const unresolved = await verifier.verify({ fingerprint, sql: "SELECT $1 AS value", operation: "read" });
    strict.deepEqual(unresolved.unavailable, ["columns", "parameters"]);
    const inspector = database.planInspector;
    strict.equal(inspector.parameterMode, "samples-required");
    const environment = await inspector.environment();
    strict.equal(environment.version, `v${version}`);
    strict.match(environment.statisticsFingerprint, /^sha256:[a-f\d]{64}$/u);
    strict.ok(Object.keys(environment.settings).includes("threads"));
    for (const [sql, operation, parameterCount, values] of [
      ["SELECT id FROM secrets", "read", 0, undefined],
      ["SELECT id FROM secrets WHERE id=$1", "read", 1, [1n]],
      ["INSERT INTO secrets VALUES(2,'PRIVATE_VALUE')", "write", 0, undefined],
      ["UPDATE secrets SET payload='OTHER_SECRET' WHERE id=1", "write", 0, undefined],
      ["DELETE FROM secrets WHERE id=1", "write", 0, undefined],
    ] as const) {
      const plan = await inspector.capture({
        fingerprint,
        sql,
        operation,
        parameterCount,
        ...(values ? { values } : {}),
      });
      strict.ok(plan.nodes.length > 0);
      strict.ok(!JSON.stringify(plan).includes("PRIVATE_VALUE"));
      strict.ok(!JSON.stringify(plan).includes("OTHER_SECRET"));
    }
    strict.deepEqual(await database.queryable.all("SELECT id,payload FROM secrets"), [
      { id: 1n, payload: "PRIVATE_VALUE" },
    ]);
    const before = environment.statisticsFingerprint;
    await database.queryable.all("INSERT INTO secrets VALUES(2,'second')");
    strict.notEqual((await inspector.environment()).statisticsFingerprint, before);
    for (const sql of [
      "SELECT $1 AS value",
      "SELECT unknown FROM secrets",
      "SELECT 1; DELETE FROM secrets",
      "EXPLAIN ANALYZE SELECT 1",
      "CREATE TABLE forbidden(id INTEGER)",
    ]) {
      await strict.rejects(
        inspector.capture({
          fingerprint,
          sql,
          operation: "read",
          parameterCount: sql.includes("$1") ? 1 : 0,
          ...(sql.includes("$1") ? { values: ["DO_NOT_LEAK"] } : {}),
        }),
        (error) =>
          error instanceof Error &&
          !error.message.includes(sql) &&
          !error.message.includes("DO_NOT_LEAK") &&
          error.cause === undefined,
      );
    }
    await strict.rejects(
      inspector.capture({ fingerprint: "bad", sql: "SELECT 1", operation: "read", parameterCount: 0 }),
      /fingerprint/u,
    );
    await strict.rejects(
      inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 1 }),
      /sample/u,
    );
    await strict.rejects(verifier.verify({ fingerprint: "bad", sql: "SELECT 1", operation: "read" }), /fingerprint/u);
    await database.transaction(async () => {
      await strict.rejects(verifier.server(), /failed/u);
    });
    await verifier.close();
    await inspector.close();
    strict.equal((await database.queryable.all("SELECT 1 AS value"))[0]?.value, 1);
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
  const ownedVerifier = await createNodeDuckDBLiveVerifier({ sdkImporter: async () => sdk });
  strict.equal((await ownedVerifier.server()).version, `v${version}`);
  await ownedVerifier.close();
  await strict.rejects(ownedVerifier.server(), /closed/u);
  const ownedInspector = await createNodeDuckDBPlanInspector({ sdkImporter: async () => sdk });
  strict.equal((await ownedInspector.environment()).version, `v${version}`);
  await ownedInspector.close();
  await strict.rejects(ownedInspector.environment(), /closed/u);
});
await it(`shares lazy initialization and drains a racing close on native ${version}`, async () => {
  for (const kind of ["verify", "plan"] as const) {
    let imports = 0,
      connectionsClosed = 0,
      instancesClosed = 0;
    let started!: () => void, finish!: () => void;
    const importing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const trackedSDK = {
      ...sdk,
      DuckDBInstance: Object.assign(() => undefined, {
        async create() {
          const instance = await sdk.DuckDBInstance.create();
          const connect = instance.connect.bind(instance),
            close = instance.closeSync.bind(instance);
          instance.closeSync = () => {
            instancesClosed++;
            close();
          };
          Object.defineProperty(instance, "connect", {
            value: async () => {
              const connection = await connect(),
                close = connection.closeSync.bind(connection);
              connection.closeSync = () => {
                connectionsClosed++;
                close();
              };
              return connection;
            },
          });
          return instance;
        },
      }),
    };
    const sdkImporter = async () => {
      imports++;
      started();
      await gate;
      return trackedSDK;
    };
    const service =
      kind === "verify"
        ? createNodeDuckDBLiveVerifier({ sdkImporter })
        : createNodeDuckDBPlanInspector({ sdkImporter });
    strict.equal(imports, 0);
    const first = "server" in service ? service.server() : service.environment();
    const second = "server" in service ? service.server() : service.environment();
    await importing;
    strict.equal(imports, 1);
    const closing = service.close();
    strict.equal(service.close(), closing);
    finish();
    await strict.rejects(first, /closed/u);
    await strict.rejects(second, /closed/u);
    await closing;
    strict.equal(connectionsClosed, 1);
    strict.equal(instancesClosed, 1);
    strict.equal(imports, 1);
    await strict.rejects("server" in service ? service.server() : service.environment(), /closed/u);
  }
});
await it(`drains an initialized service operation before native close on ${version}`, async () => {
  let connectionsClosed = 0,
    instancesClosed = 0,
    importing = 0;
  let entered!: () => void, resume!: () => void;
  const active = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
  const importer = async () => {
    importing++;
    return {
      ...sdk,
      DuckDBInstance: Object.assign(() => undefined, {
        async create() {
          const instance = await sdk.DuckDBInstance.create(),
            connect = instance.connect.bind(instance),
            close = instance.closeSync.bind(instance);
          instance.closeSync = () => {
            instancesClosed++;
            close();
          };
          Object.defineProperty(instance, "connect", {
            value: async () => {
              const connection = await connect(),
                run = connection.run.bind(connection),
                close = connection.closeSync.bind(connection);
              let reads = 0;
              Object.defineProperty(connection, "run", {
                value: async (text: string) => {
                  if (++reads === 4) {
                    entered();
                    await gate;
                  }
                  return run(text);
                },
              });
              connection.closeSync = () => {
                connectionsClosed++;
                close();
              };
              return connection;
            },
          });
          return instance;
        },
      }),
    };
  };
  const verifier = createNodeDuckDBLiveVerifier({ sdkImporter: importer });
  const pending = verifier.verify({ fingerprint, sql: "SELECT 1 AS value", operation: "read" });
  await active;
  const closing = verifier.close();
  strict.equal(connectionsClosed, 0);
  strict.equal(instancesClosed, 0);
  resume();
  strict.equal((await pending).columns[0]?.name, "value");
  await closing;
  strict.equal(connectionsClosed, 1);
  strict.equal(instancesClosed, 1);
  strict.equal(importing, 1);
  const inspector = createNodeDuckDBPlanInspector({ sdkImporter: async () => sdk, configuration: { threads: "1" } });
  const request = {
    fingerprint,
    sql: "SELECT $1::BIGINT AS value",
    operation: "read" as const,
    parameterCount: 1,
    values: [42n],
  };
  const capture = inspector.capture(request);
  request.sql = "SELECT missing";
  request.values[0] = 7n;
  strict.ok((await capture).nodes.length > 0);
  await inspector.close();
});
