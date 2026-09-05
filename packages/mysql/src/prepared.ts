import {
  DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
  PreparedQueryRenderCache,
  type Query,
  type RenderedQuery,
  registerPreparedQuery,
  type SqlRenderer,
} from "@typed-sql/core";

export interface MySqlPreparedQueryFactory<
  Arguments extends readonly unknown[],
  Row,
  Params extends readonly unknown[],
> {
  (...args: Arguments): Query<Row, Params>;
  readonly statementName: string;
}

export interface MySqlPreparedQueryMetadata {
  readonly statementName: string;
  readonly rendered: RenderedQuery;
}

interface PreparedStatement {
  readonly variants: PreparedQueryRenderCache;
}

export interface MySqlPreparedQueryState {
  readonly capacity: number;
  readonly variantCapacity: number;
  readonly statements: Map<string, PreparedStatement>;
  readonly queries: WeakMap<object, MySqlPreparedQueryMetadata>;
}

const defaultMySqlPreparedStatementLimit = 16_000;

export function createMySqlPreparedQueryState(
  capacity = defaultMySqlPreparedStatementLimit,
  variantCapacity = DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
): MySqlPreparedQueryState {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("MySQL prepared statement limit must be a positive safe integer");
  }
  new PreparedQueryRenderCache(variantCapacity);
  return {
    capacity,
    variantCapacity,
    statements: new Map(),
    queries: new WeakMap(),
  };
}

export function prepareMySqlQuery<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
  state: MySqlPreparedQueryState,
  renderer: SqlRenderer,
  statementName: string,
  factory: (...args: Arguments) => Query<Row, Params>,
): MySqlPreparedQueryFactory<Arguments, Row, Params> {
  return registerPreparedQuery({
    state,
    renderer,
    statementName,
    factory,
    metadata: (variant) => ({ statementName, rendered: variant.rendered }),
    capacity: {
      maximum: state.capacity,
      message: `MySQL prepared statement limit of ${state.capacity} has been reached; reuse an existing prepared factory or increase preparedStatementLimit`,
    },
  });
}
