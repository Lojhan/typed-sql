import { describe, it, strict } from "poku";
import {
  createDatabase,
  type QueryResultValidationError,
  type QueryStream,
  QueryResultValidationError as ResultValidationError,
  type StandardSchemaV1,
  sql,
  validateQueryResultStream,
} from "../src/index.js";

type Account = { readonly id: bigint; readonly email: string };

interface EcosystemSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: unknown; readonly output: Account } | undefined;
    readonly validate: (value: unknown) =>
      | { readonly value: Account; readonly issues?: undefined }
      | {
          readonly issues: readonly {
            readonly message: string;
            readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
          }[];
        };
  };
}

function accountSchema(
  validate: StandardSchemaV1<unknown, Account>["~standard"]["validate"],
): StandardSchemaV1<unknown, Account> {
  return { "~standard": { version: 1, vendor: "test-validator", validate } };
}

const renderer = { placeholder: () => "?", quoteIdentifier: (name: string) => `"${name}"` };

async function captureValidationError(operation: Promise<unknown>): Promise<QueryResultValidationError> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof ResultValidationError)) throw error;
    return error;
  }
  throw new Error("Expected query result validation to fail");
}

await describe("Standard Schema result validation", async () => {
  await it("accepts the exact optional-property shape used by ecosystem validators", async () => {
    const schema: EcosystemSchema = {
      "~standard": {
        version: 1,
        vendor: "ecosystem-compatible",
        validate(value) {
          return { value: value as Account };
        },
      },
    };
    const query = sql.validateResult(sql<Account>`SELECT id, email FROM account`, schema);
    const database = createDatabase({ execute: async () => [{ id: 1n, email: "a@example.test" }] }, renderer);
    strict.deepStrictEqual(await database.one(query), { id: 1n, email: "a@example.test" });
  });

  await it("validates and transforms decoded rows without changing the base query", async () => {
    const base = sql<Account>`SELECT id, email FROM account`;
    const validated = sql.validateResult(
      base,
      accountSchema((value) => {
        const row = value as { readonly id: string; readonly email: string };
        return { value: { id: BigInt(row.id), email: row.email.trim() } };
      }),
    );
    const database = createDatabase({ execute: async () => [{ id: "7", email: " a@example.test " }] }, renderer);

    strict.deepStrictEqual(await database.execute(base), [{ id: "7", email: " a@example.test " }]);
    strict.deepStrictEqual(await database.execute(validated), [{ id: 7n, email: "a@example.test" }]);
    strict.notStrictEqual(validated, base);
  });

  await it("supports asynchronous validators", async () => {
    const query = sql.validateResult(
      sql<Account>`SELECT id, email FROM account`,
      accountSchema(async (value) => {
        await Promise.resolve();
        return { value: value as Account };
      }),
    );
    const database = createDatabase({ execute: async () => [{ id: 1n, email: "a@example.test" }] }, renderer);
    strict.deepStrictEqual(await database.one(query), { id: 1n, email: "a@example.test" });
  });

  await it("redacts issue messages and values by default while retaining safe locations", async () => {
    const query = sql.validateResult(
      sql<Account>`SELECT id, email FROM account`,
      accountSchema(() => ({
        issues: [{ message: "secret@example.test is invalid", path: ["email", { key: 0 }] }],
      })),
    );
    const database = createDatabase({ execute: async () => [{ id: 1n, email: "secret@example.test" }] }, renderer);

    const validationError = await captureValidationError(database.execute(query));
    strict.strictEqual(validationError.code, "TSQL_RESULT_VALIDATION");
    strict.strictEqual(validationError.fingerprint, "generic-adapter");
    strict.strictEqual(validationError.rowIndex, 0);
    strict.strictEqual(validationError.vendor, "test-validator");
    strict.deepStrictEqual(validationError.issues, [{ path: ["email", 0] }]);
    strict.ok(!validationError.message.includes("secret@example.test"));
  });

  await it("includes validator messages only through an explicit diagnostic opt-in", async () => {
    const query = sql.validateResult(
      sql<Account>`SELECT id, email FROM account`,
      accountSchema(() => ({ issues: [{ message: "email is invalid", path: ["email"] }] })),
      { includeIssueMessages: true, libraryOptions: { locale: "en" } },
    );
    const database = createDatabase({ execute: async () => [{ id: 1n, email: "bad" }] }, renderer);
    const error = await captureValidationError(database.execute(query));
    strict.deepStrictEqual(error.issues, [{ path: ["email"], message: "email is invalid" }]);
  });

  await it("normalizes validator exceptions and malformed results", async () => {
    const thrown = sql.validateResult(
      sql<Account>`SELECT id, email FROM account`,
      accountSchema(() => {
        throw new Error("row contained a secret");
      }),
    );
    const malformed = sql.validateResult(
      sql<Account>`SELECT id, email FROM account`,
      accountSchema(() => undefined as never),
    );
    const database = createDatabase({ execute: async () => [{}] }, renderer);

    const thrownError = await captureValidationError(database.execute(thrown));
    const malformedError = await captureValidationError(database.execute(malformed));
    strict.strictEqual(thrownError.failure, "validator-exception");
    strict.strictEqual(thrownError.issues.length, 0);
    strict.strictEqual(malformedError.failure, "invalid-result");
  });

  await it("validates streams lazily and closes the source at the first invalid row", async () => {
    const query = sql.validateResult(
      sql<Account>`SELECT id, email FROM account`,
      accountSchema((value) => {
        const row = value as Account;
        return row.email.includes("@") ? { value: row } : { issues: [{ message: "invalid", path: ["email"] }] };
      }),
    );
    let index = 0;
    let closes = 0;
    const rows: readonly Account[] = [
      { id: 1n, email: "valid@example.test" },
      { id: 2n, email: "invalid" },
    ];
    const source: QueryStream<Account> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const value = rows[index++];
        return value === undefined ? { done: true, value: undefined } : { done: false, value };
      },
      async close() {
        closes += 1;
      },
      async [Symbol.asyncDispose]() {
        await this.close();
      },
    };
    const stream = validateQueryResultStream(query, source, "sha256:test");

    strict.deepStrictEqual(await stream.next(), { done: false, value: rows[0] });
    const error = await captureValidationError(stream.next());
    strict.strictEqual(error.rowIndex, 1);
    strict.strictEqual(closes, 1);
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });
  });

  await it("supports iterator return, throw, natural completion, and async disposal", async () => {
    const query = sql.validateResult(
      sql<Account>`SELECT id, email FROM account`,
      accountSchema((value) => ({ value: value as Account })),
    );
    let closes = 0;
    const source = (): QueryStream<Account> => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        return { done: true, value: undefined };
      },
      async close() {
        closes += 1;
      },
      async [Symbol.asyncDispose]() {
        await this.close();
      },
    });

    const completed = validateQueryResultStream(query, source(), "sha256:completed");
    strict.deepStrictEqual(await completed.next(), { done: true, value: undefined });
    await completed.close();

    const returned = validateQueryResultStream(query, source(), "sha256:returned");
    strict.deepStrictEqual(await returned.return?.(), { done: true, value: undefined });

    const thrown = validateQueryResultStream(query, source(), "sha256:thrown");
    await strict.rejects(thrown.throw?.(new Error("stop")) ?? Promise.resolve(), /stop/);

    const disposed = validateQueryResultStream(query, source(), "sha256:disposed");
    await disposed[Symbol.asyncDispose]();
    strict.strictEqual(closes, 3);
  });

  await it("rejects non-Standard-Schema values at the attachment boundary", () => {
    strict.throws(
      () => sql.validateResult(sql<Account>`SELECT id, email FROM account`, {} as never),
      /Standard Schema V1/,
    );
  });
});
