import {
  type BufferedDatabase,
  type BufferedOptions,
  createBufferedDatabase,
  type TransactionalDatabase,
} from "./index.js";
import { sqliteWireOptions } from "./sqlite-values.js";
import { transactionScope } from "./transaction-scope.js";

export type LibsqlClient = import("@libsql/client").Client;
type LibsqlValue = import("@libsql/client").InValue;

function encodeValues(input: readonly unknown[]): LibsqlValue[] {
  return input.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean" ||
      value instanceof ArrayBuffer ||
      value instanceof Uint8Array ||
      value instanceof Date
    )
      return value;
    throw new TypeError("Unsupported libSQL bind value; use a JSON parameter plan for structured values");
  });
}

function rows(input: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return input.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => [name, value instanceof ArrayBuffer ? new Uint8Array(value) : value]),
    ),
  );
}

export function createLibsqlDatabase(client: LibsqlClient, options: BufferedOptions): TransactionalDatabase {
  options = sqliteWireOptions(options, false);
  if (
    options.profile.jsonWire !== "text" ||
    (options.profile.jsonInputWire !== undefined && options.profile.jsonInputWire !== "text")
  )
    throw new TypeError("This adapter requires text JSON wire formats");
  if (options.profile.dialect !== "sqlite" || options.profile.integer !== "lossless")
    throw new TypeError(
      "libSQL requires a SQLite lossless transport profile; configure the client with intMode: bigint",
    );
  const database = createBufferedDatabase(
    {
      async execute(text, values) {
        return rows((await client.execute({ sql: text, args: encodeValues(values) })).rows);
      },
      async batch(statements) {
        return (
          await client.batch(
            statements.map(({ text, values }) => ({ sql: text, args: encodeValues(values) })),
            "write",
          )
        ).map((result) => rows(result.rows));
      },
    },
    options,
  );
  return Object.freeze({
    ...database,
    async transaction<T>(run: (database: BufferedDatabase) => Promise<T>): Promise<T> {
      const transaction = await client.transaction("write");
      const scope = transactionScope(
        {
          async execute(text, values) {
            return rows((await transaction.execute({ sql: text, args: encodeValues(values) })).rows);
          },
        },
        options,
      );
      try {
        const result = await run(scope.database);
        await scope.finish();
        await transaction.commit();
        return result;
      } catch (error) {
        await scope.finish().catch(() => undefined);
        await transaction.rollback().catch(() => undefined);
        throw error;
      } finally {
        transaction.close();
      }
    },
  });
}
