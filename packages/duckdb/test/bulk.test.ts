import { requireAdapterCapability, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { duckdb, typePolicy } from "../src/index.js";
import { createNodeDuckDBDatabase } from "../src/node-api.js";
import { DuckDBSchemaProvider } from "../src/provider.js";
import { duckdbAppender } from "../src/runtime.js";
const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`native vector appender preserves nested types and atomic defaults on ${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const database = await createNodeDuckDBDatabase({ sdkImporter: async () => sdk });
  try {
    strict.equal((await database.queryable.all("SELECT version() AS version"))[0]?.version, `v${version}`);
    await database.queryable.all(
      "CREATE TABLE items(id BIGINT PRIMARY KEY, doubled BIGINT GENERATED ALWAYS AS(id*2), amount DECIMAL(38,4), nested STRUCT(choice UNION(n INTEGER,s VARCHAR),attrs MAP(INTEGER,VARCHAR),coords INTEGER[2]), bytes BLOB, label VARCHAR DEFAULT 'default')",
    );
    const snapshot = await new DuckDBSchemaProvider({ client: database.queryable }).introspect();
    const compiled = (text: string, values: readonly unknown[]) => {
      const analysis = duckdb().analyze(text, snapshot);
      strict.deepEqual(analysis.diagnostics, [], text);
      const parts = text
        .split(/\$\d+/u)
        .flatMap((part, i) => (i === 0 ? [sql.raw(part)] : [sql.value(values[i - 1]), sql.raw(part)]));
      return withQueryValuePlan(sql`${sql.join(parts, sql.empty)}`, {
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
    };
    const factory = (id: bigint) =>
      compiled("INSERT INTO items(id,amount,nested,bytes) VALUES($1,$2,$3,$4)", [
        id,
        "12345678901234567890.1200",
        { choice: { tag: "n", value: null }, attrs: [[1, null]], coords: [1, null] },
        new Uint8Array([1, 2]),
      ]);
    const appender = requireAdapterCapability(database, duckdbAppender);
    const progress: unknown[] = [];
    strict.deepEqual(
      await appender.append(factory, [1n, 2n, 3n], { chunkRows: 2, onProgress: (update) => progress.push(update) }),
      { rows: 3, chunks: 2 },
    );
    strict.deepEqual(progress, [
      { rows: 2, chunks: 1 },
      { rows: 3, chunks: 2 },
    ]);
    strict.deepEqual(
      await database.queryable.all("SELECT id,doubled,amount,nested,bytes,label FROM items ORDER BY id"),
      [1n, 2n, 3n].map((id) => ({
        id,
        doubled: id * 2n,
        amount: "12345678901234567890.1200",
        nested: { choice: { tag: "n", value: null }, attrs: [[1, null]], coords: [1, null] },
        bytes: new Uint8Array([1, 2]),
        label: "default",
      })),
    );
    let returned = false;
    async function* source() {
      try {
        yield 4n;
        yield 4n;
      } finally {
        returned = true;
      }
    }
    await strict.rejects(appender.append(factory, source(), { chunkRows: 1 }), /constraint/u);
    strict.equal(returned, true);
    strict.deepEqual(await database.queryable.all("SELECT id FROM items ORDER BY id"), [
      { id: 1n },
      { id: 2n },
      { id: 3n },
    ]);
    await strict.rejects(
      appender.append(
        factory,
        (async function* () {
          yield 5n;
          throw new Error("producer failed");
        })(),
        { chunkRows: 1 },
      ),
      /producer failed/u,
    );
    await strict.rejects(
      appender.append(factory, [6n], {
        onProgress() {
          throw new Error("progress failed");
        },
      }),
      /progress failed/u,
    );
    const controller = new AbortController();
    await strict.rejects(
      appender.append(
        factory,
        (async function* () {
          yield 7n;
          controller.abort();
          yield 8n;
        })(),
        { chunkRows: 1, signal: controller.signal },
      ),
      /cancel/u,
    );
    strict.deepEqual(await appender.append(factory, []), { rows: 0, chunks: 0 });
    for (const chunkRows of [0, -1, 2049, 1.5])
      await strict.rejects(appender.append(factory, [], { chunkRows }), /chunkRows/u);
    await strict.rejects(
      database.transaction(async (tx) => {
        await requireAdapterCapability(tx, duckdbAppender).append(factory, [9n]);
        throw new Error("outer rollback");
      }),
      /outer rollback/u,
    );
    await database.transaction(async (tx) => {
      await requireAdapterCapability(tx, duckdbAppender).append(factory, [10n]);
    });
    strict.deepEqual(
      await database.queryable.all("SELECT id FROM items ORDER BY id"),
      [1n, 2n, 3n, 10n].map((id) => ({ id })),
    );
    let escaped: Promise<unknown> | undefined;
    await strict.rejects(
      database.transaction(async (tx) => {
        escaped = requireAdapterCapability(tx, duckdbAppender).append(
          factory,
          (async function* () {
            yield 11n;
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield 12n;
          })(),
          { chunkRows: 1 },
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
      /unfinished/u,
    );
    await escaped;
    strict.deepEqual(
      await database.queryable.all("SELECT id FROM items ORDER BY id"),
      [1n, 2n, 3n, 10n].map((id) => ({ id })),
    );
    await strict.rejects(
      appender.append(
        (id) =>
          id === 13n
            ? factory(id)
            : compiled("INSERT INTO items(id,amount,nested,bytes) VALUES($1,$2,$3,$4) /*changed*/", [
                id,
                null,
                null,
                null,
              ]),
        [13n, 14n],
        { chunkRows: 1 },
      ),
      /structural/u,
    );
    await strict.rejects(
      appender.append((id) => compiled("INSERT INTO items(id) VALUES($1) RETURNING id", [id]), [15n]),
      /command/u,
    );
    await strict.rejects(appender.append(factory, [15n], { deadline: new Date(0) }), /deadline/u);
    await strict.rejects(appender.append(factory, [15n], { deadline: Number.NaN }), /finite/u);
    strict.deepEqual(
      await database.queryable.all(
        "SELECT table_name FROM duckdb_tables() WHERE temporary AND table_name LIKE '__typed_sql_append_%'",
      ),
      [],
    );
  } finally {
    await database.close();
  }
});
