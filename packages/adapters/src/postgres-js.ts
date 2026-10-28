import type { Query, QueryBatch, QueryResults } from "@typed-sql/core";
import {
  type BufferedDatabase,
  type BufferedOptions,
  createBufferedDatabase,
  type TransactionalDatabase,
} from "./index.js";
import { transactionScope } from "./transaction-scope.js";

export type PostgresJsClient = import("postgres").Sql;
type PostgresJsConnection = Pick<PostgresJsClient, "unsafe">;
const utf8 = new TextDecoder();

export function createPostgresJsDatabase(client: PostgresJsClient, options: BufferedOptions): TransactionalDatabase {
  if (options.profile.dialect !== "postgres" || options.profile.jsonWire !== "text")
    throw new TypeError("Postgres.js requires a PostgreSQL raw-text transport profile");
  const executor = (connection: PostgresJsConnection) => ({
    async execute(text: string, values: readonly unknown[]) {
      const result = await connection.unsafe(text, [...values] as import("postgres").ParameterOrJSON<never>[]).raw();
      return result.map((row) => {
        if (row.length !== result.columns.length)
          throw new TypeError("Postgres.js raw row width differs from its columns");
        return Object.fromEntries(
          result.columns.map((column, index) => [column.name, row[index] === null ? null : utf8.decode(row[index])]),
        );
      });
    },
  });
  const scope = (connection: PostgresJsConnection) => createBufferedDatabase(executor(connection), options);
  const transaction = async <T>(run: (database: BufferedDatabase) => Promise<T>): Promise<T> =>
    (
      await client.begin(async (connection) => {
        const owned = transactionScope(executor(connection), options);
        try {
          const value = await run(owned.database);
          await owned.finish();
          return { value };
        } catch (error) {
          await owned.finish().catch(() => undefined);
          throw error;
        }
      })
    ).value;
  return Object.freeze({
    ...scope(client),
    transaction,
    async batch<const Queries extends readonly unknown[]>(
      queries: QueryBatch<Queries>,
    ): Promise<QueryResults<Queries>> {
      const snapshot = [...queries] as unknown as readonly Query<unknown>[];
      return transaction(async (database) => {
        const results: (readonly unknown[])[] = [];
        for (const query of snapshot) results.push(await database.all(query));
        return results as QueryResults<Queries>;
      });
    },
  });
}
