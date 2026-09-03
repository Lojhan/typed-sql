import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
  PreparedQueryRenderCache,
  type Query,
  type RenderedQuery,
  type SqlRenderer,
} from "@typed-sql/core";

export interface PostgresPreparedQueryFactory<
  Arguments extends readonly unknown[],
  Row,
  Params extends readonly unknown[],
> {
  (...args: Arguments): Query<Row, Params>;
  readonly statementName: string;
}

export interface PostgresPreparedQueryMetadata {
  readonly logicalStatementName: string;
  readonly statementName: string;
  readonly rendered: RenderedQuery;
}

interface PreparedStatement {
  readonly variants: PreparedQueryRenderCache;
}

export interface PostgresPreparedQueryState {
  readonly variantCapacity: number;
  readonly statements: Map<string, PreparedStatement>;
  readonly queries: WeakMap<object, PostgresPreparedQueryMetadata>;
}

export function createPostgresPreparedQueryState(
  variantCapacity = DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
): PostgresPreparedQueryState {
  // Validate eagerly even when no prepared factory is registered.
  new PreparedQueryRenderCache(variantCapacity);
  return {
    variantCapacity,
    statements: new Map(),
    queries: new WeakMap(),
  };
}

function physicalStatementName(statementName: string, text: string, primary: boolean): string {
  if (primary) return statementName;
  const fingerprint = createHash("sha256").update(`${statementName}\0${text}`).digest("hex").slice(0, 56);
  return `tsqlv_${fingerprint}`;
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

  const statement: PreparedStatement = { variants: new PreparedQueryRenderCache(state.variantCapacity) };
  state.statements.set(statementName, statement);

  const prepared = (...args: Arguments): Query<Row, Params> => {
    const query = factory(...args);
    const existing = state.queries.get(query);
    if (existing !== undefined && existing.logicalStatementName !== statementName) {
      throw new TypeError(
        `A query cannot use both prepared statement ${JSON.stringify(existing.statementName)} and ${JSON.stringify(statementName)}`,
      );
    }

    let rendered = existing?.rendered;
    let physicalName = existing?.statementName;
    if (rendered === undefined) {
      const variant = statement.variants.bind(query, renderer);
      rendered = variant?.rendered;
      if (variant !== undefined) {
        physicalName = physicalStatementName(statementName, variant.rendered.text, variant.primary);
      }
    }
    if (rendered === undefined || physicalName === undefined) {
      throw new TypeError(
        `Prepared statement ${JSON.stringify(statementName)} must always render the same SQL text and structure`,
      );
    }

    if (existing === undefined) {
      state.queries.set(query, { logicalStatementName: statementName, statementName: physicalName, rendered });
    }
    return query;
  };

  return Object.freeze(Object.assign(prepared, { statementName }));
}
