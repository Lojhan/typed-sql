import { connect } from "node:net";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { type QueryValuePlan, sql, withQueryValuePlan } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import postgres from "postgres";
import { WebSocket, WebSocketServer } from "ws";
import { normalizePostgresValue, postgresRenderer } from "../../postgres/src/query.js";
import type { TransactionalDatabase } from "../src/index.js";
import { createNeonWebSocketDatabase } from "../src/neon-ws.js";
import { createPostgresJsDatabase } from "../src/postgres-js.js";

const connectionString = process.env.TYPED_SQL_ADAPTER_POSTGRES_URL;
if (connectionString === undefined)
  throw new Error("Set TYPED_SQL_ADAPTER_POSTGRES_URL to a disposable local PostgreSQL database");
const target = new URL(connectionString);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
  throw new Error("This write/rollback integration test requires a local PostgreSQL host");
const profile = {
  id: "postgres-real",
  dialect: "postgres",
  integer: "lossless",
  jsonWire: "text",
  typePolicyHash: "fixture",
  normalizeValue: normalizePostgresValue,
} as const;
const options = { profile, renderer: postgresRenderer };
function statement<Row>(text: string, columns: QueryValuePlan["columns"] = []) {
  return withQueryValuePlan(sql<Row>`${sql.raw(text)}`, {
    dialect: "postgres",
    typePolicyHash: "fixture",
    columns,
    parameters: [],
  });
}

async function exercise(database: TransactionalDatabase): Promise<void> {
  const scalars = statement<{
    n: bigint;
    safe: number;
    flag: boolean;
    bytes: Uint8Array;
    date: Date;
    values: bigint[];
  }>(
    "SELECT 9223372036854775807::bigint AS n, 42::int AS safe, true AS flag, '\\x00ff'::bytea AS bytes, DATE '2026-01-02' AS date, ARRAY[1,9223372036854775807]::bigint[] AS values",
    [
      { name: "n", type: "bigint", nullable: false },
      { name: "safe", type: "number", nullable: false },
      { name: "flag", type: "boolean", nullable: false },
      { name: "bytes", type: "bytes", nullable: false },
      { name: "date", type: "date", nullable: false },
      { name: "values", type: { array: "bigint" }, nullable: false },
    ],
  );
  const row = await database.one(scalars);
  strict.equal(row.n, 9_223_372_036_854_775_807n);
  strict.equal(row.safe, 42);
  strict.equal(row.flag, true);
  strict.deepEqual(row.bytes, Uint8Array.of(0, 255));
  strict.ok(row.date instanceof Date);
  strict.deepEqual(row.values, [1n, 9_223_372_036_854_775_807n]);
  const json = statement<{ doc: string }>("SELECT '{\"n\":9223372036854775807}'::json AS doc", [
    { name: "doc", type: "string", nullable: false, json: { shape: { kind: "unknown" }, representation: "text" } },
  ]);
  strict.equal((await database.one(json)).doc, '{"n":9223372036854775807}');
  await database.all(statement("CREATE TEMP TABLE typed_sql_adapter_test (id INTEGER PRIMARY KEY)"));
  await database.transaction(async (scope) => {
    await scope.all(statement("INSERT INTO typed_sql_adapter_test VALUES (1)"));
  });
  await strict.rejects(
    database.transaction(async (scope) => {
      await scope.all(statement("INSERT INTO typed_sql_adapter_test VALUES (2)"));
      throw new Error("expected rollback");
    }),
    /expected rollback/u,
  );
  await strict.rejects(
    database.batch([
      statement("INSERT INTO typed_sql_adapter_test VALUES (3)"),
      statement("INSERT INTO typed_sql_adapter_test VALUES (1)"),
    ] as const),
  );
  const ids = await database.all(
    statement<{ id: number }>("SELECT id FROM typed_sql_adapter_test ORDER BY id", [
      { name: "id", type: "number", nullable: false },
    ]),
  );
  strict.deepEqual(
    ids.map((item) => item.id),
    [1],
  );
  let escaped: Parameters<TransactionalDatabase["transaction"]>[0] extends (scope: infer Scope) => unknown
    ? Scope
    : never;
  await database.transaction(async (scope) => {
    escaped = scope;
  });
  await strict.rejects(escaped!.all(scalars), /no longer active/u);
  await strict.rejects(
    database.transaction(async (scope) => {
      void scope.all(statement("SELECT 1 / 0 AS failed", [{ name: "failed", type: "number", nullable: false }]));
    }),
    /division by zero/u,
  );
  await database.all(statement("DROP TABLE typed_sql_adapter_test"));
  await strict.rejects(database.all(scalars, { signal: new AbortController().signal }), /cancellation/u);
  strict.equal("stream" in database, false);
}

await describe("actual PostgreSQL adapter protocols", async () => {
  await it("executes Postgres.js native raw queries and transactions", async () => {
    const client = postgres(connectionString, { max: 1 });
    try {
      await exercise(createPostgresJsDatabase(client, options));
    } finally {
      await client.end();
    }
  });
  await it("executes the actual Neon WebSocket driver against a local protocol bridge", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (ws) => {
      const socket = connect({ host: target.hostname, port: Number(target.port || 5432) });
      ws.on("message", (data) =>
        socket.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)),
      );
      socket.on("data", (data) => ws.send(data));
      socket.on("error", () => ws.close());
      socket.on("close", () => ws.close());
      ws.on("close", () => socket.destroy());
      ws.on("error", () => socket.destroy());
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("WebSocket bridge did not bind");
    neonConfig.webSocketConstructor = WebSocket;
    neonConfig.wsProxy = () => `127.0.0.1:${address.port}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.forceDisablePgSSL = true;
    neonConfig.pipelineConnect = false;
    const pool = new Pool({ connectionString, max: 1, ssl: false });
    try {
      await exercise(createNeonWebSocketDatabase(pool, options));
    } finally {
      await pool.end();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
