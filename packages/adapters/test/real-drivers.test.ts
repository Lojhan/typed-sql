import { createClient } from "@libsql/client";
import { neon, neonConfig } from "@neondatabase/serverless";
import { getAdapterCapability, type QueryValuePlan, sql, withQueryValuePlan } from "@typed-sql/core";

import { describe, it, strict } from "poku";
import { normalizePostgresValue, postgresRenderer } from "../../postgres/src/query.js";
import { sqliteRenderer } from "../../sqlite/src/query.js";
import { createD1Database, type D1Binding, d1Sessions } from "../src/d1.js";
import type { BatchDatabase } from "../src/index.js";
import { createLibsqlDatabase } from "../src/libsql.js";
import { createNeonHttpDatabase } from "../src/neon-http.js";

const sqliteProfile = {
  id: "fixture-sqlite",
  dialect: "sqlite",
  integer: "lossless",
  jsonWire: "text",
  typePolicyHash: "fixture",
} as const;
const postgresProfile = {
  id: "fixture-postgres",
  dialect: "postgres",
  integer: "lossless",
  jsonWire: "text",
  typePolicyHash: "fixture",
  normalizeValue: normalizePostgresValue,
} as const;

function statement<Row>(text: string, dialect: string, columns: QueryValuePlan["columns"] = []) {
  return withQueryValuePlan(sql<Row>`${sql.raw(text)}`, {
    dialect,
    typePolicyHash: "fixture",
    columns,
    parameters: [],
  });
}

async function sqliteValues(database: BatchDatabase): Promise<void> {
  const blob = withQueryValuePlan(sql<{ bytes: Uint8Array }>`SELECT ${Uint8Array.of(0, 255)} AS bytes`, {
    dialect: "sqlite",
    typePolicyHash: "fixture",
    columns: [{ name: "bytes", type: "bytes", nullable: false }],
    parameters: [{ index: 1, type: "bytes", nullable: false }],
  });
  strict.deepEqual((await database.one(blob)).bytes, Uint8Array.of(0, 255));
  await database.all(statement("CREATE TABLE json_values (id INTEGER PRIMARY KEY, doc TEXT) STRICT", "sqlite"));
  for (const [id, value] of [
    [1, sql.json({ hello: "world" })],
    [2, null],
    [3, sql.json(null)],
    [4, sql.json("hello")],
  ] as const) {
    const insert = withQueryValuePlan(sql`INSERT INTO json_values VALUES (${id}, ${value})`, {
      dialect: "sqlite",
      typePolicyHash: "fixture",
      columns: [],
      parameters: [
        { index: 1, type: "number", nullable: false },
        { index: 2, type: "unknown", nullable: true, json: { shape: { kind: "unknown" }, representation: "parsed" } },
      ],
    });
    await database.all(insert);
  }
  const query = statement<{ doc: unknown; was_null: number }>(
    "SELECT doc, doc IS NULL AS was_null FROM json_values ORDER BY id",
    "sqlite",
    [
      { name: "doc", type: "unknown", nullable: true, json: { shape: { kind: "unknown" }, representation: "parsed" } },
      { name: "was_null", type: "number", nullable: false },
    ],
  );
  const rows = await database.all(query);
  strict.deepEqual(
    rows.map((row) => [row.doc, row.was_null]),
    [
      [{ hello: "world" }, 0],
      [null, 1],
      [null, 0],
      ["hello", 0],
    ],
  );
}

await describe("explicit buffered driver boundaries", async () => {
  await it("executes real workerd D1 bindings, native rollback batches, sessions and precision rejection", async () => {
    // This published Miniflare version's declarations reference missing dev-only
    // modules. Exercise its actual workerd runtime against our public D1 binding contract.
    const { Miniflare } = (await import(import.meta.resolve("miniflare"))) as {
      Miniflare: new (
        options: unknown,
      ) => { getD1Database(name: string): Promise<D1Binding>; dispose(): Promise<void> };
    };
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: "2026-07-30",
      d1Databases: ["DB"],
    });
    try {
      const binding = await mf.getD1Database("DB");
      const database = createD1Database(binding, {
        renderer: sqliteRenderer,
        profile: { ...sqliteProfile, id: "d1", integer: "safe-number" },
      });
      strict.equal("transaction" in database, false);
      strict.equal("stream" in database, false);
      await database.all(statement("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT", "sqlite"));
      const insert = withQueryValuePlan(
        sql`INSERT INTO items (id, name) VALUES (${7}, ${"Ada'; DROP TABLE items; --"})`,
        {
          dialect: "sqlite",
          typePolicyHash: "fixture",
          columns: [],
          parameters: [
            { index: 1, type: "number", nullable: false },
            { index: 2, type: "string", nullable: false },
          ],
        },
      );
      await database.all(insert);
      await sqliteValues(database);
      const query = statement<{ id: number; name: string }>("SELECT id, name FROM items", "sqlite", [
        { name: "id", type: "number", nullable: false },
        { name: "name", type: "string", nullable: false },
      ]);
      strict.deepEqual((await database.one(query)).name, "Ada'; DROP TABLE items; --");
      await strict.rejects(
        database.batch([
          statement("INSERT INTO items VALUES (8, 'second')", "sqlite"),
          statement("INSERT INTO items VALUES (7, 'duplicate')", "sqlite"),
        ] as const),
      );
      strict.equal((await database.all(query)).length, 1);
      const session = getAdapterCapability(database, d1Sessions)!.withSession("first-primary");
      strict.equal((await session.one(query)).id, 7);
      const blob = await database.one(
        statement<{ bytes: Uint8Array }>("SELECT X'00ff' AS bytes", "sqlite", [
          { name: "bytes", type: "bytes", nullable: false },
        ]),
      );
      strict.deepEqual(blob.bytes, Uint8Array.of(0, 255));
      strict.ok(session.getBookmark() === null || typeof session.getBookmark() === "string");
      await strict.rejects(
        database.all(
          statement("SELECT 9223372036854775807 AS n", "sqlite", [{ name: "n", type: "number", nullable: false }]),
        ),
        /unsafe/u,
      );
      await strict.rejects(
        database.all(statement("SELECT 7 AS n", "sqlite", [{ name: "n", type: "bigint", nullable: false }])),
        /bigint/u,
      );
      await strict.rejects(database.all(query, { signal: new AbortController().signal }), /cancellation/u);
    } finally {
      await mf.dispose();
    }
  });

  await it("executes libSQL's native bigint mode and interactive transactions without precision recovery", async () => {
    const client = createClient({ url: "file::memory:", intMode: "bigint" });
    try {
      const database = createLibsqlDatabase(client, { renderer: sqliteRenderer, profile: sqliteProfile });
      await database.all(statement("CREATE TABLE items (id INTEGER PRIMARY KEY) STRICT", "sqlite"));
      await sqliteValues(database);
      const maximum = statement<{ n: bigint }>("SELECT 9223372036854775807 AS n", "sqlite", [
        { name: "n", type: "bigint", nullable: false },
      ]);
      strict.equal((await database.one(maximum)).n, 9_223_372_036_854_775_807n);
      await database.transaction(async (transaction) => {
        await transaction.all(statement("INSERT INTO items VALUES (1)", "sqlite"));
      });
      await strict.rejects(
        database.transaction(async (transaction) => {
          await transaction.all(statement("INSERT INTO items VALUES (2)", "sqlite"));
          throw new Error("rollback");
        }),
        /rollback/u,
      );
      const rows = await database.all(
        statement<{ id: bigint }>("SELECT id FROM items ORDER BY id", "sqlite", [
          { name: "id", type: "bigint", nullable: false },
        ]),
      );
      strict.deepEqual(
        rows.map((row) => row.id),
        [1n],
      );
      let escaped: Parameters<typeof database.transaction>[0] extends (scope: infer Scope) => unknown ? Scope : never;
      await database.transaction(async (scope) => {
        escaped = scope;
      });
      await strict.rejects(escaped!.all(maximum), /no longer active/u);
      await strict.rejects(
        database.transaction(async (scope) => {
          void scope.all(statement("SELECT missing FROM missing_table", "sqlite"));
        }),
        /missing_table/u,
      );
      const blob = await database.one(
        statement<{ bytes: Uint8Array }>("SELECT X'00ff' AS bytes", "sqlite", [
          { name: "bytes", type: "bytes", nullable: false },
        ]),
      );
      strict.deepEqual(blob.bytes, Uint8Array.of(0, 255));
      strict.equal("stream" in database, false);
    } finally {
      client.close();
    }
  });

  await it("uses the actual Neon HTTP driver with raw parsers for exact JSON and noninteractive batching", async () => {
    const previousFetch = neonConfig.fetchFunction;
    const payloads: unknown[] = [];
    const json = '{"n":9223372036854775807}';
    const result = {
      fields: [{ name: "doc", dataTypeID: 3802, format: "text" }],
      rows: [[json]],
      command: "SELECT",
      rowCount: 1,
    };
    neonConfig.fetchFunction = async (_url: unknown, options: { body: string }) => {
      const body = JSON.parse(options.body) as { queries?: readonly unknown[] };
      payloads.push(body);
      return Response.json(body.queries === undefined ? result : { results: body.queries.map(() => result) });
    };
    try {
      const client = neon("postgresql://fixture:fixture@example.test/database", { fullResults: true });
      const database = createNeonHttpDatabase(client, { renderer: postgresRenderer, profile: postgresProfile });
      const query = statement<{ doc: string }>("SELECT '{}'::jsonb AS doc", "postgres", [
        { name: "doc", type: "string", nullable: false, json: { shape: { kind: "unknown" }, representation: "text" } },
      ]);
      strict.equal((await database.one(query)).doc, json);
      const batch = await database.batch([query, query] as const);
      strict.deepEqual(
        batch.map((rows) => rows[0]?.doc),
        [json, json],
      );
      strict.equal(payloads.length, 2, "batch uses one HTTP request, not individual fetches");
      strict.equal("transaction" in database, false);
    } finally {
      neonConfig.fetchFunction = previousFetch;
    }
  });
});
