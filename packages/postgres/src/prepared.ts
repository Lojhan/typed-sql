import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS,
  PreparedQueryRenderCache,
  type Query,
  type RenderedQuery,
  registerPreparedQuery,
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

export function preparePostgresQuery<Arguments extends readonly unknown[], Row, Params extends readonly unknown[]>(
  state: PostgresPreparedQueryState,
  renderer: SqlRenderer,
  statementName: string,
  factory: (...args: Arguments) => Query<Row, Params>,
): PostgresPreparedQueryFactory<Arguments, Row, Params> {
  return registerPreparedQuery({
    state,
    renderer,
    statementName,
    factory,
    ownerName: (metadata: PostgresPreparedQueryMetadata) => metadata.logicalStatementName,
    metadata: (variant) => ({
      logicalStatementName: statementName,
      statementName: physicalStatementName(statementName, variant.rendered.text, variant.primary),
      rendered: variant.rendered,
    }),
  });
}
