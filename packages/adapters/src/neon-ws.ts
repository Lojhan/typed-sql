import type { Query, QueryBatch, QueryResults } from "@typed-sql/core";
import {
  type BufferedDatabase,
  type BufferedOptions,
  createBufferedDatabase,
  rawPostgresTypes,
  type TransactionalDatabase,
} from "./index.js";
import { transactionScope } from "./transaction-scope.js";

export interface NeonWsConnection {
  query(config: {
    text: string;
    values: unknown[];
    types: typeof rawPostgresTypes;
  }): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(): void;
}
export interface NeonWsPool {
  query(config: {
    text: string;
    values: unknown[];
    types: typeof rawPostgresTypes;
  }): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  connect(): Promise<NeonWsConnection>;
}

export function createNeonWebSocketDatabase(pool: NeonWsPool, options: BufferedOptions): TransactionalDatabase {
  if (options.profile.dialect !== "postgres" || options.profile.jsonWire !== "text")
    throw new TypeError("Neon WebSocket requires a PostgreSQL raw-text transport profile");
  const scope = (client: Pick<NeonWsConnection, "query">) =>
    createBufferedDatabase(
      {
        async execute(text, values) {
          return (await client.query({ text, values: [...values], types: rawPostgresTypes })).rows;
        },
      },
      options,
    );
  const transaction = async <T>(run: (database: BufferedDatabase) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query({ text: "BEGIN", values: [], types: rawPostgresTypes });
      const owned = transactionScope(
        {
          async execute(text, values) {
            return (await client.query({ text, values: [...values], types: rawPostgresTypes })).rows;
          },
        },
        options,
      );
      try {
        const result = await run(owned.database);
        await owned.finish();
        await client.query({ text: "COMMIT", values: [], types: rawPostgresTypes });
        return result;
      } catch (error) {
        await owned.finish().catch(() => undefined);
        await client.query({ text: "ROLLBACK", values: [], types: rawPostgresTypes }).catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  };
  // Sequential dispatch inside one reserved native connection is an atomic batch.
  const base = scope(pool);
  return Object.freeze({
    ...base,
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
