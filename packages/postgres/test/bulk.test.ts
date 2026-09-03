import type { Query, QueryStream } from "@typed-sql/core";
import { sql } from "@typed-sql/postgres";
import { describe, it, strict } from "poku";
import { createPostgresCopyCapability, type PostgresCopyTransport } from "../src/bulk.js";

class EmptyByteStream implements QueryStream<Uint8Array> {
  [Symbol.asyncIterator](): this {
    return this;
  }
  async next(): Promise<IteratorResult<Uint8Array, undefined>> {
    return { done: true, value: undefined };
  }
  async return(): Promise<IteratorResult<Uint8Array, undefined>> {
    return { done: true, value: undefined };
  }
  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

function recorder() {
  const statements: string[] = [];
  const chunks: Uint8Array[] = [];
  const transport: PostgresCopyTransport = {
    async copyFrom(statement, source) {
      statements.push(statement);
      for await (const chunk of source) chunks.push(chunk);
    },
    copyTo(statement) {
      statements.push(statement);
      return new EmptyByteStream();
    },
  };
  return { capability: createPostgresCopyCapability(transport), chunks, statements };
}

const decode = (chunks: readonly Uint8Array[]): string => new TextDecoder().decode(Buffer.concat(chunks));

await describe("PostgreSQL COPY capability", async () => {
  await it("derives COPY columns and ordered CSV values from a typed INSERT factory", async () => {
    const { capability, chunks, statements } = recorder();
    const progress: { readonly rows: number; readonly bytes: number }[] = [];
    const result = await capability.copyFrom(
      (row: { readonly id: bigint; readonly email: string; readonly active: boolean; readonly note: string | null }) =>
        sql`INSERT INTO public.account (id, email, active, note) VALUES (${row.id}, ${row.email}, ${row.active}, ${row.note})`,
      [
        { id: 1n, email: "one@example.com", active: true, note: null },
        { id: 2n, email: 'two,"quoted"@example.com', active: false, note: "line\nbreak" },
      ],
      { chunkBytes: 16, onProgress: (value) => progress.push(value) },
    );

    strict.deepStrictEqual(statements, [
      'COPY "public"."account" ("id", "email", "active", "note") FROM STDIN WITH (FORMAT csv)',
    ]);
    strict.strictEqual(
      decode(chunks),
      '"1","one@example.com","true",\n"2","two,""quoted""@example.com","false","line\nbreak"\n',
    );
    strict.deepStrictEqual(result, { rows: 2, bytes: 84 });
    strict.deepStrictEqual(progress.at(-1), result);
  });

  await it("does no driver work for an empty input", async () => {
    const { capability, statements } = recorder();
    const result = await capability.copyFrom((id: bigint) => sql`INSERT INTO account (id) VALUES (${id})`, []);
    strict.deepStrictEqual(result, { rows: 0, bytes: 0 });
    strict.deepStrictEqual(statements, []);
  });

  await it("uses PostgreSQL-compatible text input for dates, JSON, bytea, and arrays", async () => {
    const { capability, chunks } = recorder();
    await capability.copyFrom(
      (row: {
        readonly createdAt: Date;
        readonly payload: { readonly enabled: boolean };
        readonly bytes: Uint8Array;
        readonly tags: readonly string[];
      }) => sql`
        INSERT INTO event (created_at, payload, bytes, tags)
        VALUES (${row.createdAt}, ${row.payload}, ${row.bytes}, ${row.tags})
      `,
      [
        {
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          payload: { enabled: true },
          bytes: new Uint8Array([0, 255]),
          tags: ["one", "two"],
        },
      ],
    );
    strict.strictEqual(
      decode(chunks),
      '"2026-01-01T00:00:00.000Z","{""enabled"":true}","\\x00ff","{""one"",""two""}"\n',
    );
  });

  await it("encodes nested arrays and PostgreSQL null array elements", async () => {
    const { capability, chunks } = recorder();
    await capability.copyFrom(
      (row: { readonly values: readonly unknown[]; readonly optional: undefined }) =>
        sql`INSERT INTO array_input (array_values, optional) VALUES (${sql.value(row.values)}, ${row.optional})`,
      [{ values: [null, undefined, ["nested"]], optional: undefined }],
    );
    const output = decode(chunks);
    strict.ok(output.includes("NULL,NULL"));
    strict.ok(output.endsWith(",\n"));
  });

  await it("fails closed when a later row changes structural SQL", async () => {
    const { capability } = recorder();
    await strict.rejects(
      capability.copyFrom(
        (row: { readonly id: bigint; readonly alternate: boolean }) =>
          row.alternate
            ? sql`INSERT INTO archive (id) VALUES (${row.id})`
            : sql`INSERT INTO account (id) VALUES (${row.id})`,
        [
          { id: 1n, alternate: false },
          { id: 2n, alternate: true },
        ],
      ),
      /changed its structural SQL shape/u,
    );
  });

  await it("rejects statements that cannot soundly map one input row", async () => {
    const { capability } = recorder();
    await strict.rejects(
      capability.copyFrom((id: bigint) => sql`INSERT INTO account (id) VALUES (${id}) RETURNING id`, [1n]),
      /plain single-row INSERT/u,
    );
    await strict.rejects(
      capability.copyFrom((id: bigint) => sql`UPDATE account SET id = ${id}`, [1n]),
      /plain single-row INSERT/u,
    );
    await strict.rejects(
      capability.copyFrom((id: bigint) => sql`INSERT INTO account VALUES (${id})`, [1n]),
      /plain single-row INSERT/u,
    );
    await strict.rejects(
      capability.copyFrom((id: bigint) => sql`INSERT INTO account (id) VALUES (${id} + 1)`, [1n]),
      /one ordered parameter/u,
    );
  });

  await it("rejects invalid chunk sizes and values without driver work", async () => {
    const { capability, statements } = recorder();
    for (const chunkBytes of [0, 1.5]) {
      await strict.rejects(
        capability.copyFrom((id: bigint) => sql`INSERT INTO account (id) VALUES (${id})`, [1n], { chunkBytes }),
        /positive safe integer/u,
      );
    }
    for (const value of [Number.POSITIVE_INFINITY, new Date(Number.NaN), Symbol("unsupported")]) {
      await strict.rejects(
        capability.copyFrom((input: unknown) => sql`INSERT INTO account (value) VALUES (${input})`, [value]),
        /cannot encode/u,
      );
    }
    strict.strictEqual(statements.length, 3);
  });

  await it("wraps a static typed SELECT for COPY TO STDOUT", async () => {
    const { capability, statements } = recorder();
    await capability
      .copyTo(sql.__typed<{ readonly id: bigint }, readonly []>()`SELECT account.id FROM account ORDER BY account.id`)
      .close();
    strict.deepStrictEqual(statements, [
      "COPY (SELECT account.id FROM account ORDER BY account.id) TO STDOUT WITH (FORMAT csv)",
    ]);

    const parameterized = sql.__typed<{ readonly id: bigint }, readonly [bigint]>()`
      SELECT account.id FROM account WHERE account.id = ${1n}
    ` as unknown as Query<{ readonly id: bigint }, readonly []>;
    strict.throws(() => capability.copyTo(parameterized), /only static queries/u);
    strict.throws(
      () => capability.copyTo(sql.__typed<never, readonly []>()`UPDATE account SET active = true`),
      /requires a SELECT/u,
    );
  });

  await it("honors cancellation before acquiring a transport", async () => {
    const { capability, statements } = recorder();
    const controller = new AbortController();
    controller.abort("stop");
    await strict.rejects(
      capability.copyFrom((id: bigint) => sql`INSERT INTO account (id) VALUES (${id})`, [1n], {
        signal: controller.signal,
      }),
      (error) => error instanceof Error && error.name === "QueryCancelledError",
    );
    strict.deepStrictEqual(statements, []);
  });

  await it("closes a producer exactly once when the transport rejects before consuming", async () => {
    let returns = 0;
    const failure = new Error("transport unavailable");
    const capability = createPostgresCopyCapability({
      async copyFrom() {
        throw failure;
      },
      copyTo() {
        return new EmptyByteStream();
      },
    });
    const rows: AsyncIterable<bigint> = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: 1n };
          },
          async return() {
            returns += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await strict.rejects(
      () => capability.copyFrom((id) => sql`INSERT INTO account (id) VALUES (${id})`, rows),
      failure,
    );
    strict.strictEqual(returns, 1);
  });
});
