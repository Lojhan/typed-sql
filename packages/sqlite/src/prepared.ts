import {
  DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
  PreparedQueryRenderCache,
  type Query,
  type RenderedQuery,
  registerPreparedQuery,
  type SqlRenderer,
} from "@typed-sql/core";

export interface SqlitePreparedQueryFactory<
  Arguments extends readonly unknown[],
  Row,
  Params extends readonly unknown[],
> {
  (...args: Arguments): Query<Row, Params>;
  readonly statementName: string;
}

export interface SqlitePreparedQueryMetadata {
  readonly statementName: string;
  readonly rendered: RenderedQuery;
}

interface PreparedStatement {
  readonly variants: PreparedQueryRenderCache;
}

export interface SqlitePreparedQueryState {
  readonly variantCapacity: number;
  readonly statements: Map<string, PreparedStatement>;
  readonly queries: WeakMap<object, SqlitePreparedQueryMetadata>;
}

export function createSqlitePreparedQueryState(
  variantCapacity = DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
): SqlitePreparedQueryState {
  new PreparedQueryRenderCache(variantCapacity);
  return {
    variantCapacity,
    statements: new Map(),
    queries: new WeakMap(),
  };
}

export function prepareSqliteQuery<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
  state: SqlitePreparedQueryState,
  renderer: SqlRenderer,
  statementName: string,
  factory: (...args: Arguments) => Query<Row, Params>,
): SqlitePreparedQueryFactory<Arguments, Row, Params> {
  return registerPreparedQuery({
    state,
    renderer,
    statementName,
    factory,
    metadata: (variant) => ({ statementName, rendered: variant.rendered }),
  });
}
