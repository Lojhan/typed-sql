import {
  PreparedQueryRenderCache,
  type PreparedQueryRenderVariant,
  type Query,
  type RenderedQuery,
  type SqlRenderer,
} from "./query.js";

/** Grammar-neutral registration and query ownership; adapters supply naming and capacity policy. */
export function registerPreparedQuery<
  Arguments extends readonly unknown[],
  Row,
  Params extends readonly unknown[],
  Metadata extends { readonly statementName: string; readonly rendered: RenderedQuery },
>(options: {
  readonly state: {
    readonly variantCapacity: number;
    readonly statements: Map<string, { readonly variants: PreparedQueryRenderCache }>;
    readonly queries: WeakMap<object, Metadata>;
  };
  readonly renderer: SqlRenderer;
  readonly statementName: string;
  readonly factory: (...args: Arguments) => Query<Row, Params>;
  readonly metadata: (variant: PreparedQueryRenderVariant) => Metadata;
  readonly ownerName?: (metadata: Metadata) => string;
  readonly capacity?: { readonly maximum: number; readonly message: string };
}): ((...args: Arguments) => Query<Row, Params>) & { readonly statementName: string } {
  const { state, renderer, statementName, factory } = options;
  if (typeof statementName !== "string" || statementName.length === 0 || statementName.includes("\0"))
    throw new TypeError("Prepared statement names must be non-empty and cannot contain NUL");
  if (state.statements.has(statementName))
    throw new TypeError(`Prepared statement name ${JSON.stringify(statementName)} is already registered`);
  if (options.capacity !== undefined && state.statements.size >= options.capacity.maximum)
    throw new RangeError(options.capacity.message);
  const statement = { variants: new PreparedQueryRenderCache(state.variantCapacity) };
  state.statements.set(statementName, statement);
  const prepared = (...args: Arguments): Query<Row, Params> => {
    const query = factory(...args);
    const existing = state.queries.get(query);
    if (existing !== undefined) {
      if ((options.ownerName?.(existing) ?? existing.statementName) !== statementName)
        throw new TypeError(
          `A query cannot use both prepared statement ${JSON.stringify(existing.statementName)} and ${JSON.stringify(statementName)}`,
        );
      return query;
    }
    const variant = statement.variants.bind(query, renderer);
    if (variant === undefined)
      throw new TypeError(
        `Prepared statement ${JSON.stringify(statementName)} must always render the same SQL text and structure`,
      );
    state.queries.set(query, options.metadata(variant));
    return query;
  };
  return Object.freeze(Object.assign(prepared, { statementName }));
}
