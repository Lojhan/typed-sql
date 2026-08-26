import type { Query } from "./query.js";

/** The buffered rows produced by executing one typed query. */
export type QueryResult<Value> = Value extends Query<infer Row, infer _Params> ? readonly Row[] : never;

/**
 * Maps an ordered query tuple or array to its ordered buffered results.
 *
 * A tuple remains a tuple, while a homogeneous query array remains an array.
 */
export type QueryResults<Queries extends readonly unknown[]> = {
  readonly [Index in keyof Queries]: QueryResult<Queries[Index]>;
};

/** Validates an ordered tuple or array while preserving every query's exact type. */
export type QueryBatch<Queries extends readonly unknown[]> = Queries & {
  readonly [Index in keyof Queries]: Queries[Index] extends Query<infer Row, infer Params> ? Query<Row, Params> : never;
};

/** Common, grammar-neutral stream configuration. */
export interface StreamOptions {
  /**
   * Preferred number of rows fetched or buffered at a time.
   *
   * Adapters must reject values that are not positive safe integers. This is a row count, not a
   * byte limit or a guarantee of server-side cursor paging.
   */
  readonly batchSize?: number;
}

/** A lazy, explicitly closeable stream of typed query rows. */
export interface QueryStream<Row> extends AsyncIterableIterator<Row>, AsyncDisposable {
  close(): Promise<void>;
}
