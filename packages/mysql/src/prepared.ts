import {
  bindQueryRenderSkeleton,
  compileQueryRenderSkeleton,
  type Query,
  type QueryRenderSkeleton,
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
  skeleton: QueryRenderSkeleton | undefined;
}

export interface MySqlPreparedQueryState {
  readonly statements: Map<string, PreparedStatement>;
  readonly queries: WeakMap<object, MySqlPreparedQueryMetadata>;
}

export function createMySqlPreparedQueryState(): MySqlPreparedQueryState {
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

  const statement: PreparedStatement = { skeleton: undefined };
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
    const skeleton = statement.skeleton;
    if (rendered === undefined) {
      if (skeleton === undefined) {
        const compiled = compileQueryRenderSkeleton(query, renderer);
        statement.skeleton = compiled.skeleton;
        rendered = compiled.rendered;
      } else {
        rendered = bindQueryRenderSkeleton(query, skeleton);
      }
    }
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
