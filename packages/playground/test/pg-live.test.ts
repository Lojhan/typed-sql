import { sql } from "@typed-sql/postgres";
import { describe, it, skip, strict } from "poku";
import { createPgPlaygroundTarget, PlaygroundPgCancellationError, PlaygroundPgError } from "../src/pg.js";

const connectionString = process.env.TYPED_SQL_PLAYGROUND_PG_URL;
if (connectionString === undefined) skip("Set TYPED_SQL_PLAYGROUND_PG_URL for real PostgreSQL adapter verification");
const target = createPgPlaygroundTarget({ connectionString: connectionString!, schemas: ["playground_adapter_test"] });
const run = (
  text: string,
  options: {
    readOnly?: boolean;
    maxRows?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    values?: readonly unknown[];
    maxResultBytes?: number;
  } = {},
) =>
  target.query({
    text,
    values: options.values ?? [],
    readOnly: options.readOnly ?? true,
    maxRows: options.maxRows ?? 100,
    timeoutMs: options.timeoutMs ?? 3000,
    signal: options.signal ?? new AbortController().signal,
    ...(options.maxResultBytes === undefined ? {} : { maxResultBytes: options.maxResultBytes }),
  });

try {
  await describe("real PostgreSQL managed execution", async () => {
    await it("reports observed database identity and lossless ordered metadata", async () => {
      const identity = await target.identity();
      strict.equal(identity.adapter, "pg");
      strict.match(identity.server, /PostgreSQL/);
      const result = await run(
        "select 9007199254740993::bigint as duplicate, 1.2300::numeric as duplicate, null::text as absent, '{\"a\":1}'::jsonb as document",
      );
      strict.deepEqual(
        result.columns.map((column) => column.name),
        ["duplicate", "duplicate", "absent", "document"],
      );
      strict.deepEqual(result.rows[0], [9007199254740993n, "1.2300", null, { a: 1 }]);
      strict.equal(result.truncated, false);
      const empty = await run("select 1::integer as id where false");
      strict.deepEqual(empty.rows, []);
      strict.equal(empty.columns[0]?.name, "id");
    });

    await it("bounds fetch without rewriting SQL and separates parameter values", async () => {
      const result = await run("select generate_series(1, 100000) as id", { maxRows: 3 });
      strict.deepEqual(result.rows, [[1], [2], [3]]);
      strict.equal(result.truncated, true);
      const parameterized = await run("select $1::text as value", { values: ["x'; drop table anything; --"] });
      strict.equal(parameterized.rows[0]?.[0], "x'; drop table anything; --");
      await strict.rejects(() => run("select repeat('x', 1000) as payload", { maxResultBytes: 10 }), /byte budget/);
    });

    await it("streams more than 500 rows on demand without duplicates and suspends execution deadlines while idle", async () => {
      const rows: number[] = [];
      let pages = 0;
      let first: (() => void) | undefined;
      let resume: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        first = resolve;
      });
      const demand = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const operation = target.query({
        text: "select generate_series(1, 1203)::integer as id",
        values: [],
        readOnly: true,
        maxRows: Number.MAX_SAFE_INTEGER,
        pageSize: 137,
        timeoutMs: 200,
        signal: new AbortController().signal,
        onRows: async (batch) => {
          pages++;
          rows.push(...batch.rows.map((row) => row[0] as number));
          if (pages === 1) {
            first!();
            await demand;
          }
        },
      });
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 300));
      strict.equal(pages, 1, "no cursor pull before demand");
      strict.equal(rows.length, 137);
      resume!();
      const result = await operation;
      strict.deepEqual(
        rows,
        Array.from({ length: 1203 }, (_, i) => i + 1),
      );
      strict.deepEqual(result.rows, [], "streamed result does not accumulate rows in adapter memory");
      strict.equal(result.truncated, false);
      strict.equal(result.affectedRows, undefined, "SELECT count is not affected rows");
    });

    await it("closes an idle cursor on cancellation and releases its connection for another query", async () => {
      const controller = new AbortController();
      let started: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const operation = target.query({
        text: "select generate_series(1, 2000)",
        values: [],
        readOnly: true,
        maxRows: Number.MAX_SAFE_INTEGER,
        pageSize: 100,
        timeoutMs: 1000,
        signal: controller.signal,
        onRows: async () => {
          started!();
          await new Promise<void>((_resolve, reject) =>
            controller.signal.addEventListener("abort", () => reject(new Error("closed")), { once: true }),
          );
        },
      });
      await ready;
      controller.abort();
      await strict.rejects(operation, (error: unknown) => error instanceof PlaygroundPgCancellationError);
      strict.equal((await run("select 42::integer as value")).rows[0]?.[0], 42);
    });

    await it("aborts even when a public streaming consumer ignores its signal forever", async () => {
      const controller = new AbortController();
      let first: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        first = resolve;
      });
      const operation = target.query({
        text: "select generate_series(1,2000)",
        values: [],
        readOnly: true,
        maxRows: Number.MAX_SAFE_INTEGER,
        pageSize: 100,
        timeoutMs: 1000,
        signal: controller.signal,
        onRows: async () => {
          first!();
          await new Promise<void>(() => {});
        },
      });
      await ready;
      controller.abort();
      await strict.rejects(operation, (error: unknown) => error instanceof PlaygroundPgCancellationError);
      strict.equal((await run("select 7::integer as id")).rows[0]?.[0], 7);
    });

    await it("rejects multiple statements through the extended protocol", async () => {
      await strict.rejects(
        () => run("select 1; select 2"),
        (error: unknown) =>
          typeof error === "object" && error !== null && "sqlState" in error && error.sqlState === "42601",
      );
    });

    await it("uses actual read-only transactions and permits deliberate writes", async () => {
      await run("create schema if not exists playground_adapter_test", { readOnly: false });
      await run("create table if not exists playground_adapter_test.accounts(id integer primary key, name text)", {
        readOnly: false,
      });
      await run("delete from playground_adapter_test.accounts", { readOnly: false });
      await strict.rejects(
        () =>
          run(
            "with mutation as (insert into playground_adapter_test.accounts values (1,'blocked') returning *) select * from mutation",
          ),
        /read-only/,
      );
      const insert = await run("insert into playground_adapter_test.accounts values (1, 'allowed') returning id", {
        readOnly: false,
      });
      strict.deepEqual(insert.rows, [[1]]);
      strict.deepEqual((await run("select name from playground_adapter_test.accounts")).rows, [["allowed"]]);
      const snapshot = await target.snapshot!();
      strict.equal(snapshot.dialect, "postgres");
      strict.ok(snapshot.tables["playground_adapter_test.accounts"]);
    });

    await it("enforces server deadlines and abort signals, then remains usable", async () => {
      await strict.rejects(() => run("select pg_sleep(10)", { timeoutMs: 100 }), /deadline/);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await strict.rejects(
          () => run("select pg_sleep(10)", { signal: controller.signal }),
          (error: unknown) =>
            error instanceof PlaygroundPgCancellationError && error.confirmed && !error.outcomeUnknown,
        );
      } finally {
        clearTimeout(timer);
      }
      strict.deepEqual((await run("select 42 as answer")).rows, [[42]]);
    });

    await it("reports uncertain writes after backend loss and never reuses the lost connection", async () => {
      await strict.rejects(
        () => run("select pg_terminate_backend(pg_backend_pid())", { readOnly: false }),
        (error: unknown) => error instanceof PlaygroundPgError && error.outcomeUnknown,
      );
      strict.deepEqual((await run("select 73 as answer")).rows, [[73]]);
      const database = await target.database({
        readOnly: false,
        maxRows: 10,
        timeoutMs: 3000,
        signal: new AbortController().signal,
      });
      await strict.rejects(
        () =>
          database.transaction(async (tx) => {
            await tx.all(sql`select pg_terminate_backend(pg_backend_pid())`);
          }),
        (error: unknown) => error instanceof PlaygroundPgError && error.outcomeUnknown,
      );
      strict.deepEqual(await database.all(sql`select 74 as answer`), [{ answer: 74 }]);
    });

    await it("preserves application runtime codecs and rolls transactions back", async () => {
      const db = await target.database({
        readOnly: true,
        maxRows: 10,
        timeoutMs: 3000,
        signal: new AbortController().signal,
      });
      strict.deepEqual(await db.all(sql`select 9007199254740993::bigint as value`), [{ value: 9007199254740993n }]);
      await strict.rejects(() => db.all(sql`select generate_series(1, 11) as value`), /result limit/);
      const writable = await target.database({
        readOnly: false,
        maxRows: 10,
        timeoutMs: 3000,
        signal: new AbortController().signal,
      });
      await strict.rejects(
        () =>
          writable.transaction(async (tx) => {
            await tx.all(sql`insert into playground_adapter_test.accounts values (2, 'rollback')`);
            throw new Error("abort test transaction");
          }),
        /abort test/,
      );
      strict.deepEqual((await run("select id from playground_adapter_test.accounts order by id")).rows, [[1]]);
      await writable.all(sql`insert into playground_adapter_test.accounts values (3, 'controlled')`, {
        deadline: Date.now() + 2000,
      });
      strict.deepEqual((await run("select id from playground_adapter_test.accounts order by id")).rows, [[1], [3]]);
      await writable.transaction(async (tx) => {
        await tx.all(sql`insert into playground_adapter_test.accounts values (4, 'outer')`);
        await strict.rejects(
          () =>
            tx.transaction(async (nested) => {
              await nested.all(sql`insert into playground_adapter_test.accounts values (5, 'inner')`);
              throw new Error("nested rollback");
            }),
          /nested rollback/,
        );
      });
      strict.deepEqual((await run("select id from playground_adapter_test.accounts order by id")).rows, [
        [1],
        [3],
        [4],
      ]);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await strict.rejects(
          () => db.all(sql`select pg_sleep(10)`, { signal: controller.signal }),
          (error: unknown) =>
            error instanceof PlaygroundPgCancellationError && !error.confirmed && error.outcomeUnknown,
        );
      } finally {
        clearTimeout(timer);
      }
      strict.deepEqual(await db.all(sql`select 42 as value`), [{ value: 42 }]);
    });

    await it("supports the configured string policy without global parser mutations", async () => {
      const strings = createPgPlaygroundTarget({
        connectionString: connectionString!,
        typePolicy: {
          bigint: "string",
          numeric: "string",
          date: "string",
          json: "string",
          enums: "string-union",
          unknown: "unknown",
        },
      });
      try {
        const result = await strings.query({
          text: "select 9007199254740993::bigint as id, '2026-11-06'::date as day, '{}'::jsonb as body",
          values: [],
          readOnly: true,
          maxRows: 10,
          timeoutMs: 3000,
          signal: new AbortController().signal,
        });
        strict.deepEqual(result.rows, [["9007199254740993", "2026-11-06", "{}"]]);
      } finally {
        await strings.close();
      }
    });
  });
} finally {
  await run("drop schema if exists playground_adapter_test cascade", { readOnly: false }).catch(() => undefined);
  await target.close();
}
