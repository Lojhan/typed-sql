import {
  assertExecutionCapabilities,
  assertQueryResultTransport,
  type Database,
  decodeQueryResultRows,
  type ExecutionOptions,
  encodeQueryValues,
  getQueryValuePlan,
  type Query,
  type QueryBatch,
  QueryCardinalityError,
  type QueryExecutor,
  type QueryResults,
  type QueryTransportProfile,
  renderQuery,
  type SqlRenderer,
  validateQueryResultRows,
} from "@typed-sql/core";

export type BufferedDatabase = Pick<Database, "execute" | "all" | "one" | "maybeOne" | "executionCapabilities">;

export interface BatchDatabase extends BufferedDatabase {
  batch<const Queries extends readonly unknown[]>(queries: QueryBatch<Queries>): Promise<QueryResults<Queries>>;
}

export interface TransactionalDatabase extends BatchDatabase {
  transaction<T>(run: (database: BufferedDatabase) => Promise<T>): Promise<T>;
}

export interface BufferedOptions {
  readonly renderer: SqlRenderer;
  readonly profile: QueryTransportProfile;
  /** Explicit escape hatch for applications with their own runtime schema validation. */
  readonly decodeRows?: (query: Query<unknown>, rows: readonly unknown[]) => readonly unknown[];
}

export interface BufferedExecutor extends QueryExecutor {
  batch?(
    statements: readonly { readonly text: string; readonly values: readonly unknown[] }[],
  ): Promise<readonly (readonly unknown[])[]>;
}

const executionCapabilities = Object.freeze({ cancellation: false, deadlines: false });

export function prepareBufferedQuery(query: Query<unknown>, options: BufferedOptions) {
  const plan = getQueryValuePlan(query);
  if (plan === undefined && options.decodeRows === undefined)
    throw new TypeError("Buffered adapters require a compiled query value plan or an explicit decodeRows function");
  if (plan !== undefined) assertQueryResultTransport(query, options.profile);
  const rendered = renderQuery(query, options.renderer);
  return {
    text: rendered.text,
    values: plan === undefined ? rendered.values : encodeQueryValues(query, rendered.values, options.profile),
  };
}

async function decode<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  rows: readonly unknown[],
  options: BufferedOptions,
): Promise<readonly Row[]> {
  const decoded =
    options.decodeRows === undefined
      ? decodeQueryResultRows(query, rows, options.profile)
      : options.decodeRows(query as unknown as Query<unknown>, rows);
  return validateQueryResultRows(query, decoded, options.profile.id);
}

/** Buffered execution only: optional driver features are exposed by their explicit factories. */
export function createBufferedDatabase(
  executor: BufferedExecutor & Required<Pick<BufferedExecutor, "batch">>,
  options: BufferedOptions,
): BatchDatabase;
export function createBufferedDatabase(executor: QueryExecutor, options: BufferedOptions): BufferedDatabase;
export function createBufferedDatabase(
  executor: BufferedExecutor,
  options: BufferedOptions,
): BufferedDatabase | BatchDatabase {
  const all = async <Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    controls?: ExecutionOptions,
  ): Promise<readonly Row[]> => {
    if (controls !== undefined) assertExecutionCapabilities(executionCapabilities, controls);
    const statement = prepareBufferedQuery(query as unknown as Query<unknown>, options);
    return decode(query, await executor.execute(statement.text, statement.values), options);
  };
  const database = {
    executionCapabilities,
    execute: all,
    all,
    async one<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) {
      const rows = await all(query, controls);
      if (rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
      return rows[0]!;
    },
    async maybeOne<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, controls?: ExecutionOptions) {
      const rows = await all(query, controls);
      if (rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
      return rows[0];
    },
  };
  if (executor.batch === undefined) return Object.freeze(database);
  return Object.freeze({
    ...database,
    async batch<const Queries extends readonly unknown[]>(
      queries: QueryBatch<Queries>,
    ): Promise<QueryResults<Queries>> {
      if (executor.batch === undefined) throw new TypeError("This adapter has no native atomic batch capability");
      const snapshot = [...queries] as Query<unknown>[];
      const statements = snapshot.map((query) => prepareBufferedQuery(query, options));
      if (snapshot.length === 0) return [] as unknown as QueryResults<Queries>;
      const results = await executor.batch(statements);
      if (results.length !== snapshot.length)
        throw new TypeError("Native batch result count does not match the query count");
      const decoded: (readonly unknown[])[] = [];
      for (const [index, query] of snapshot.entries()) decoded.push(await decode(query, results[index]!, options));
      return decoded as QueryResults<Queries>;
    },
  });
}

/** A raw text parser prevents driver JSON/number parsing from discarding precision. */
export const rawPostgresTypes = Object.freeze({
  getTypeParser:
    () =>
    (value: string): string =>
      value,
});

/** D1 cannot accept or faithfully return arbitrary 64-bit integer JavaScript values. */
export function assertSafeNumbers(values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value === "bigint") throw new TypeError("This transport does not support bigint values");
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    )
      throw new RangeError("This transport cannot preserve an unsafe numeric value");
  }
}
