import {
  DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
  PreparedQueryRenderCache,
  type Query,
  type RenderedQuery,
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

function validateStatementName(statementName: string): void {
  if (typeof statementName !== "string" || statementName.length === 0 || statementName.includes("\0")) {
    throw new TypeError("Prepared statement names must be non-empty and cannot contain NUL");
  }
}

export function prepareSqliteQuery<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
  state: SqlitePreparedQueryState,
  renderer: SqlRenderer,
  statementName: string,
  factory: (...args: Arguments) => Query<Row, Params>,
): SqlitePreparedQueryFactory<Arguments, Row, Params> {
  validateStatementName(statementName);
  if (state.statements.has(statementName)) {
    throw new TypeError(`Prepared statement name ${JSON.stringify(statementName)} is already registered`);
  }

  const statement: PreparedStatement = { variants: new PreparedQueryRenderCache(state.variantCapacity) };
  state.statements.set(statementName, statement);

  const prepared = (...args: Arguments): Query<Row, Params> => {
    const query = factory(...args);
    const existing = state.queries.get(query);
    if (existing !== undefined && existing.statementName !== statementName) {
      throw new TypeError(
        `A query cannot use both prepared statement ${JSON.stringify(existing.statementName)} and ${JSON.stringify(statementName)}`,
      );
    }

    let rendered = existing?.rendered;
    if (rendered === undefined) rendered = statement.variants.bind(query, renderer)?.rendered;
    if (rendered === undefined) {
      throw new TypeError(
        `Prepared statement ${JSON.stringify(statementName)} must always render the same SQL text and structure`,
      );
    }

    if (existing === undefined) state.queries.set(query, { statementName, rendered });
    return query;
  };

  return Object.freeze(Object.assign(prepared, { statementName }));
}
