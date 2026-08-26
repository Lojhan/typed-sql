import { type Query, type RenderedQuery, renderQuery, type SqlRenderer } from "@typed-sql/core";

export interface PostgresPreparedQueryFactory<
  Arguments extends readonly unknown[],
  Row,
  Params extends readonly unknown[],
> {
  (...args: Arguments): Query<Row, Params>;
  readonly statementName: string;
}

export interface PostgresPreparedQueryMetadata {
  readonly statementName: string;
  readonly rendered: RenderedQuery;
}

interface PreparedStatement {
  text: string | undefined;
}

export interface PostgresPreparedQueryState {
  readonly statements: Map<string, PreparedStatement>;
  readonly queries: WeakMap<object, PostgresPreparedQueryMetadata>;
}

export function createPostgresPreparedQueryState(): PostgresPreparedQueryState {
  return {
    statements: new Map(),
    queries: new WeakMap(),
  };
}

function validateStatementName(statementName: string): void {
  if (typeof statementName !== "string" || statementName.length === 0 || statementName.includes("\0")) {
    throw new TypeError("Prepared statement names must be non-empty and cannot contain NUL");
  }
}

export function preparePostgresQuery<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
  state: PostgresPreparedQueryState,
  renderer: SqlRenderer,
  statementName: string,
  factory: (...args: Arguments) => Query<Row, Params>,
): PostgresPreparedQueryFactory<Arguments, Row, Params> {
  validateStatementName(statementName);
  if (state.statements.has(statementName)) {
    throw new TypeError(`Prepared statement name ${JSON.stringify(statementName)} is already registered`);
  }

  const statement: PreparedStatement = { text: undefined };
  state.statements.set(statementName, statement);

  const prepared = (...args: Arguments): Query<Row, Params> => {
    const query = factory(...args);
    const existing = state.queries.get(query);
    if (existing !== undefined && existing.statementName !== statementName) {
      throw new TypeError(
        `A query cannot use both prepared statement ${JSON.stringify(existing.statementName)} and ${JSON.stringify(statementName)}`,
      );
    }

    const rendered = existing?.rendered ?? renderQuery(query, renderer);
    if (statement.text === undefined) statement.text = rendered.text;
    else if (statement.text !== rendered.text) {
      throw new TypeError(`Prepared statement ${JSON.stringify(statementName)} must always render the same SQL text`);
    }

    if (existing === undefined) state.queries.set(query, { statementName, rendered });
    return query;
  };

  return Object.freeze(Object.assign(prepared, { statementName }));
}
