import {
  DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
  PreparedQueryRenderCache,
  type Query,
  type RenderedQuery,
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

export const defaultMySqlPreparedStatementLimit = 16_000;

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

function validateStatementName(statementName: string): void {
  if (typeof statementName !== "string" || statementName.length === 0 || statementName.includes("\0")) {
    throw new TypeError("Prepared statement names must be non-empty and cannot contain NUL");
  }
}

export function prepareMySqlQuery<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
  state: MySqlPreparedQueryState,
  renderer: SqlRenderer,
  statementName: string,
  factory: (...args: Arguments) => Query<Row, Params>,
): MySqlPreparedQueryFactory<Arguments, Row, Params> {
  validateStatementName(statementName);
  if (state.statements.has(statementName)) {
    throw new TypeError(`Prepared statement name ${JSON.stringify(statementName)} is already registered`);
  }
  if (state.statements.size >= state.capacity) {
    throw new RangeError(
      `MySQL prepared statement limit of ${state.capacity} has been reached; reuse an existing prepared factory or increase preparedStatementLimit`,
    );
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
