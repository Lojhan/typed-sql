import { parseDuckDBType } from "../src/native-types.js";
import { duckDBRuntimeType } from "../src/type-policy.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");

import { type Query, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { duckDBServerEvidence, duckdb, typePolicy } from "../src/index.js";
import { adaptDuckDBConnection, createNodeDuckDBDatabase } from "../src/node-api.js";
import { createDuckDBDatabase, type DuckDBDatabase } from "../src/runtime.js";
import type { DuckDBSchemaSnapshot } from "../src/snapshot.js";

const snapshot = (version: string): DuckDBSchemaSnapshot => ({
  formatVersion: 1,
  dialect: "duckdb",
  dialectVersion: "1.0.0",
  server: duckDBServerEvidence(version),
  tables: {
    items: {
      name: "items",
      schema: "main",
      columns: {
        id: { name: "id", databaseType: "BIGINT", tsType: "bigint", nullable: false },
        name: { name: "name", databaseType: "VARCHAR", tsType: "string", nullable: false },
        amount: { name: "amount", databaseType: "DECIMAL(38,4)", tsType: "string", nullable: true },
      },
    },
  },
});
function compiled<Row = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
  version = "2.0.0",
): Query<Row> {
  const analysis = duckdb().analyze(text, snapshot(version));
  strict.deepEqual(analysis.diagnostics, [], text);
  const fragments = text
    .split(/\$\d+/u)
    .flatMap((part, i) => (i === 0 ? [sql.raw(part)] : [sql.value(values[i - 1]), sql.raw(part)]));
  return withQueryValuePlan(sql<Row>`${sql.join(fragments, sql.empty)}`, {
    dialect: "duckdb",
    typePolicyHash: calculateTypePolicyHash(typePolicy),
    columns: analysis.columns.map((column) => ({
      name: column.name,
      type: column.runtimeType!,
      nullable: column.nullable,
      databaseType: column.databaseType!,
    })),
    parameters: analysis.parameters.map((parameter) => ({
      index: parameter.index,
      type: parameter.runtimeType!,
      nullable: parameter.nullable,
      databaseType: parameter.databaseType!,
    })),
  });
}
await describe("DuckDB native execution and lifecycle", async () => {
  for (const driver of [sdk])
    await it(`executes exact nested values, transactions, typed parameters and recovery on ${driver.version()}`, async () => {
      strict.equal(driver.version(), process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "v1.5.6" : "v2.0.0");
      const database = await createNodeDuckDBDatabase({ sdkImporter: async () => driver });
      const version = driver.version().slice(1),
        q = <Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) =>
          compiled<Row>(text, values, version);
      try {
        await database.queryable.all(
          "CREATE TABLE items(id BIGINT PRIMARY KEY,name VARCHAR NOT NULL,amount DECIMAL(38,4))",
        );
        strict.deepEqual(
          await database.one(
            q("INSERT INTO items VALUES($1,$2,$3) RETURNING id,name,amount", [
              9223372036854775807n,
              "Ada",
              "12345678901234567890.1200",
            ]),
          ),
          { id: 9223372036854775807n, name: "Ada", amount: "12345678901234567890.1200" },
        );
        const nested = await database.one(
          q("SELECT $1::STRUCT(ids BIGINT[], attrs MAP(INTEGER,VARCHAR), choice UNION(n INTEGER,s VARCHAR)) AS value", [
            {
              ids: [1n, null],
              attrs: [
                [1, "a"],
                [2, null],
              ],
              choice: { tag: "n", value: null },
            },
          ]),
        );
        strict.deepEqual(nested.value, {
          ids: [1n, null],
          attrs: [
            [1, "a"],
            [2, null],
          ],
          choice: { tag: "n", value: null },
        });
        strict.deepEqual(await database.one(q("SELECT $1::INTEGER[3] AS arr", [[1, null, 3]])), { arr: [1, null, 3] });
        strict.deepEqual(await database.one(q("SELECT $1::TIMESTAMP_NS AS value", ["1969-12-31 23:59:59.999999999"])), {
          value: "1969-12-31 23:59:59.999999999",
        });
        await strict.rejects(database.one(q("SELECT $1::DECIMAL(4,2) AS value", ["1.234"])), /rounding/u);
        await strict.rejects(
          database.batch([
            q("INSERT INTO items VALUES($1,$2,$3)", [1n, "a", null]),
            q("INSERT INTO items VALUES($1,$2,$3)", [1n, "b", null]),
          ]),
          /constraint/iu,
        );
        strict.equal(await database.maybeOne(q("SELECT id FROM items WHERE id=$1", [1n])), undefined);
        await strict.rejects(
          database.transaction(async (tx) => {
            await tx.all(q("INSERT INTO items VALUES($1,$2,$3)", [2n, "b", null]));
            throw new Error("rollback");
          }),
          /rollback/u,
        );
        strict.equal(await database.maybeOne(q("SELECT id FROM items WHERE id=$1", [2n])), undefined);
        const prepare = database.prepare("find-item", (id: bigint) => q("SELECT id,name FROM items WHERE id=$1", [id]));
        strict.equal((await database.one(prepare(9223372036854775807n))).name, "Ada");
        await strict.rejects(
          database.all(
            withQueryValuePlan(sql`SELECT ${1n}::BIGINT AS id`, {
              dialect: "duckdb",
              typePolicyHash: calculateTypePolicyHash(typePolicy),
              columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "BIGINT" }],
              parameters: [{ index: 1, type: "bigint", nullable: false }],
            }),
          ),
          /physical target metadata/u,
        );
        const stream = database.stream(q("SELECT range FROM range(10000)"));
        strict.equal((await stream.next()).value?.range, 0n);
        await stream.close();
        strict.equal((await database.one(q("SELECT 1 AS value"))).value, 1);
        const abort = new AbortController();
        abort.abort();
        await strict.rejects(database.all(q("SELECT 1 AS value"), { signal: abort.signal }), /cancelled/u);
      } finally {
        await database.close();
      }
      await strict.rejects(database.all(q("SELECT 1 AS value")), /closed/u);
    });
  await it("keeps an injected connection alive and rejects root access during transactions", async () => {
    const instance = await sdk.DuckDBInstance.create(),
      connection = await instance.connect();
    const database = await createNodeDuckDBDatabase({ connection, sdkImporter: async () => sdk });
    try {
      let escaped: DuckDBDatabase | undefined;
      await database.transaction(async (tx) => {
        escaped = tx as DuckDBDatabase;
        await strict.rejects(database.all(compiled("SELECT 1 AS value")), /active transaction/u);
      });
      await strict.rejects(escaped!.all(compiled("SELECT 1 AS value")), /completed/u);
      await database.close();
      const result = await connection.run("SELECT 1");
      result.closeSync();
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});
await it("preserves tagged NULL through each native container and ordered map keys", async () => {
  const database = await createNodeDuckDBDatabase({ sdkImporter: async () => sdk }),
    version = sdk.version().slice(1);
  const value = { tag: "n", value: null };
  try {
    for (const [target, input] of [
      ["UNION(n INTEGER,s VARCHAR)", value],
      ["UNION(n INTEGER,s VARCHAR)[]", [value, null, { tag: "s", value: "value" }]],
      ["UNION(n INTEGER,s VARCHAR)[2]", [value, null]],
      ["STRUCT(x UNION(n INTEGER,s VARCHAR))", { x: value }],
      [
        "MAP(UNION(n INTEGER,s VARCHAR),UNION(n INTEGER,s VARCHAR))",
        [
          [value, { tag: "s", value: null }],
          [{ tag: "s", value: "key" }, null],
        ],
      ],
    ] as const) {
      const row = await database.one(compiled(`SELECT $1::${target} AS value`, [input], version));
      strict.deepEqual(row.value, input);
      const empty = await database.one(compiled(`SELECT $1::${target} AS value`, [null], version));
      strict.equal(empty.value, null);
    }
    if (version === "2.0.0") {
      const target = "TUPLE(UNION(n INTEGER,s VARCHAR),VARCHAR)",
        input = [value, null];
      strict.deepEqual((await database.one(compiled(`SELECT $1::${target} AS value`, [input], version))).value, input);
    }
    strict.deepEqual(
      (await database.one(compiled("SELECT row($1::INTEGER,$2::VARCHAR) AS value", [1, null], version))).value,
      [1, null],
    );
  } finally {
    await database.close();
  }
});
await it("rolls back unawaited cardinality failures and drains scoped operations", async () => {
  const database = await createNodeDuckDBDatabase({ sdkImporter: async () => sdk }),
    version = sdk.version().slice(1);
  try {
    await database.queryable.all(
      "CREATE TABLE items(id BIGINT PRIMARY KEY,name VARCHAR NOT NULL,amount DECIMAL(38,4))",
    );
    await strict.rejects(
      database.transaction(async (tx) => {
        void tx.all(compiled("INSERT INTO items VALUES($1,$2,$3)", [5n, "pending", null], version));
        void tx.one(compiled("SELECT id FROM items WHERE id=$1", [6n], version));
      }),
      /exactly one row/u,
    );
    strict.equal(await database.maybeOne(compiled("SELECT id FROM items WHERE id=$1", [5n], version)), undefined);
  } finally {
    await database.close();
  }
});
await it("drains a native interrupt/deadline and immediately reuses the connection", async () => {
  const database = await createNodeDuckDBDatabase({ sdkImporter: async () => sdk }),
    version = sdk.version().slice(1);
  try {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 20);
    try {
      await strict.rejects(
        database.all(compiled("SELECT sum(range) AS total FROM range(1000000000000)", [], version), {
          signal: controller.signal,
        }),
        /cancelled/u,
      );
    } finally {
      clearTimeout(timer);
    }
    strict.equal((await database.one(compiled("SELECT 1 AS value", [], version))).value, 1);
    await strict.rejects(
      database.all(compiled("SELECT sum(range) AS total FROM range(1000000000000)", [], version), {
        deadline: Date.now() + 10,
      }),
      /deadline/u,
    );
    strict.equal((await database.one(compiled("SELECT 2 AS value", [], version))).value, 2);
  } finally {
    await database.close();
  }
});

await it("rejects malformed SDK imports and foreign native handles before dispatch", async () => {
  await strict.rejects(createNodeDuckDBDatabase({ sdkImporter: async () => ({}) }), /missing required capability/u);
  await strict.rejects(createNodeDuckDBDatabase({ sdkImporter: async () => null }), /official SDK module/u);
  await strict.rejects(createNodeDuckDBDatabase({ connection: {}, sdkImporter: async () => sdk }), /same SDK module/u);
  await strict.rejects(createNodeDuckDBDatabase({ instance: {}, sdkImporter: async () => sdk }), /same SDK module/u);
});
await it("checks leased semantic settings and prepared DML metadata before dispatch", async () => {
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const database = await createNodeDuckDBDatabase({ connection, sdkImporter: async () => sdk });
  const raw = async (text: string) => {
    const result = await connection.run(text);
    try {
      return await result.getRows();
    } finally {
      result.closeSync();
    }
  };
  try {
    await database.one(compiled("SELECT 1 AS value", [], sdk.version().slice(1)));
    await raw("SET integer_division=true");
    await strict.rejects(database.one(compiled("SELECT 1 AS value", [], sdk.version().slice(1))), /integer_division/u);
    await raw("SET integer_division=false");
    await raw("CREATE TABLE metadata_guard(id BIGINT)");
    const wrong = withQueryValuePlan(sql`INSERT INTO metadata_guard VALUES(7) RETURNING id`, {
      dialect: "duckdb",
      typePolicyHash: calculateTypePolicyHash(typePolicy),
      parameters: [],
      columns: [{ name: "id", type: "string", nullable: false, databaseType: "VARCHAR" }],
    });
    await strict.rejects(database.all(wrong), /metadata differs/u);
    strict.deepEqual(await raw("SELECT count(*) FROM metadata_guard"), [[0n]]);
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
});
await it("rolls back successful unfinished requests and partially consumed scoped streams", async () => {
  const database = await createNodeDuckDBDatabase({ sdkImporter: async () => sdk }),
    version = sdk.version().slice(1);
  try {
    await database.queryable.all(
      "CREATE TABLE items(id BIGINT PRIMARY KEY,name VARCHAR NOT NULL,amount DECIMAL(38,4))",
    );
    await strict.rejects(
      database.transaction(async (tx) => {
        void tx.all(compiled("INSERT INTO items VALUES($1,$2,$3)", [7n, "unfinished", null], version));
      }),
      /unfinished operations/u,
    );
    strict.equal(await database.maybeOne(compiled("SELECT id FROM items WHERE id=$1", [7n], version)), undefined);
    await strict.rejects(
      database.transaction(async (tx) => {
        await tx.all(compiled("INSERT INTO items VALUES($1,$2,$3)", [8n, "stream", null], version));
        const stream = tx.stream(compiled("SELECT range FROM range(10000)", [], version));
        strict.equal((await stream.next()).done, false);
      }),
      /unfinished operations/u,
    );
    strict.equal(await database.maybeOne(compiled("SELECT id FROM items WHERE id=$1", [8n], version)), undefined);
    const queries = [compiled("SELECT 11 AS value", [], version)];
    const batch = database.batch(queries);
    queries[0] = compiled("SELECT 22 AS value", [], version);
    strict.deepEqual(await batch, [[{ value: 11 }]]);
    const controller = new AbortController(),
      stream = database.stream(compiled("SELECT range FROM range(10000)", [], version), { signal: controller.signal });
    strict.equal((await stream.next()).done, false);
    controller.abort();
    await strict.rejects(stream.next(), /cancelled/u);
    await stream.close();
    strict.equal((await database.one(compiled("SELECT 1 AS value", [], version))).value, 1);
  } finally {
    await database.close();
  }
});

await it("preserves unspellable 1.5 unnamed tuples through typed NULL transport witnesses", async () => {
  const database = await createNodeDuckDBDatabase({ sdkImporter: async () => sdk });
  const union = "UNION(n INTEGER,s VARCHAR)",
    tuple = `TUPLE(${union},VARCHAR)`;
  const cases: readonly (readonly [string, unknown])[] = [
    [tuple, [{ tag: "n", value: null }, null]],
    [tuple, null],
    [`${tuple}[2]`, [[{ tag: "n", value: null }, null], null]],
    [`${tuple}[2]`, null],
    [`${tuple}[]`, [[{ tag: "s", value: "a" }, null], null]],
    [`UNION(t ${tuple},n INTEGER)`, { tag: "t", value: [{ tag: "n", value: null }, null] }],
    [`UNION(t ${tuple},n INTEGER)`, { tag: "t", value: null }],
    [
      `MAP(${tuple},${tuple}[2])`,
      [
        [
          [{ tag: "n", value: null }, null],
          [[{ tag: "s", value: null }, null], null],
        ],
      ],
    ],
    [`STRUCT(all_null ${tuple}, data ${tuple}[2])`, { all_null: null, data: null }],
  ];
  try {
    strict.equal(sdk.version(), process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "v1.5.6" : "v2.0.0");
    for (const [target, input] of cases) {
      const type = duckDBRuntimeType(parseDuckDBType(target));
      const query = withQueryValuePlan(sql<{ value: unknown }>`SELECT ${sql.value(input)} AS value`, {
        dialect: "duckdb",
        typePolicyHash: calculateTypePolicyHash(typePolicy),
        parameters: [{ index: 1, type, nullable: true, databaseType: target }],
        columns: [{ name: "value", type, nullable: true, databaseType: target }],
      });
      strict.deepEqual((await database.one(query)).value, input, target);
    }
  } finally {
    await database.close();
  }
});
await it("preserves native prepared cache identity through attached result validators", async () => {
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const adapted = adaptDuckDBConnection(connection, sdk);
  let prepares = 0;
  const database = createDuckDBDatabase({
    connection: {
      ...adapted,
      async prepare(text) {
        prepares++;
        return adapted.prepare(text);
      },
    },
  });
  try {
    const factory = database.prepare("validated", () =>
      compiled<{ value: number }>("SELECT 1 AS value", [], sdk.version().slice(1)),
    );
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate(value: unknown) {
          return { value };
        },
      },
    };
    strict.deepEqual(await database.one(sql.validateResult(factory(), schema)), { value: 1 });
    strict.deepEqual(await database.one(sql.validateResult(factory(), schema)), { value: 1 });
    strict.equal(prepares, 1);
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
});
