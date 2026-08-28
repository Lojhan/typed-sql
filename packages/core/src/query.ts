import {
  assertExecutionCapabilities,
  type ExecutionCapabilities,
  type ExecutionOptions,
  QueryCardinalityError,
} from "./execution.js";

const fragmentBrand: unique symbol = Symbol.for("@typed-sql/core.fragment") as never;
const queryBrand: unique symbol = Symbol.for("@typed-sql/core.query") as never;
const queryRenderSkeletonBrand: unique symbol = Symbol("@typed-sql/core.query-render-skeleton");

export type SqlSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "identifier"; readonly name: string };

export interface SqlFragment<Params extends readonly unknown[] = readonly unknown[]> {
  readonly [fragmentBrand]: () => Params;
  readonly segments: readonly SqlSegment[];
}

export type QueryRow<Value> = Value extends Query<infer Row, infer _Params> ? Row : never;
export type QueryParameters<Value> = Value extends Query<infer _Row, infer Params> ? Params : never;

type SqlPartParameters<Part> = [Part] extends [SqlFragment<infer Params>] ? Params : readonly [Part];

export type SqlPartsParameters<
  Parts extends readonly unknown[],
  Accumulator extends readonly unknown[] = readonly [],
> = number extends Parts["length"]
  ? readonly unknown[]
  : Parts extends readonly [infer Head, ...infer Tail]
    ? SqlPartsParameters<Tail, readonly [...Accumulator, ...SqlPartParameters<Head>]>
    : Accumulator;

type CheckedSqlParts<Parts extends readonly unknown[], Expected extends readonly unknown[]> = Parts &
  ([SqlPartsParameters<Parts>] extends [Expected] ? unknown : never);

type PresentFragment<Part> = Exclude<Part, false | null | undefined>;
type OptionalFragmentParameters<Part> = [PresentFragment<Part>] extends [never]
  ? readonly []
  : PresentFragment<Part> extends SqlFragment<infer Params>
    ? Params
    : readonly unknown[];

export type FragmentListParameters<
  Parts extends readonly unknown[],
  Accumulator extends readonly unknown[] = readonly [],
> = number extends Parts["length"]
  ? readonly OptionalFragmentParameters<Parts[number]>[number][]
  : Parts extends readonly [infer Head, ...infer Tail]
    ? FragmentListParameters<Tail, readonly [...Accumulator, ...OptionalFragmentParameters<Head>]>
    : Accumulator;

export type OptionalSqlFragment = SqlFragment | false | null | undefined;
export interface Query<Row, Params extends readonly unknown[] = readonly unknown[]> {
  readonly [queryBrand]: {
    readonly row: (value: Row) => Row;
    readonly params: (value: Params) => Params;
  };
  readonly segments: readonly SqlSegment[];
}

export interface SqlTag {
  <Row = unknown, Parts extends readonly unknown[] = readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: Parts
  ): Query<Row, SqlPartsParameters<Parts>>;
  /**
   * @internal Reserved compiler-overlay protocol. Applications must use the `sql` tag directly;
   * this member may change alongside matching core/compiler releases without application-level compatibility.
   */
  readonly __typed: <Row, Params extends readonly unknown[]>() => <const Parts extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: CheckedSqlParts<Parts, Params>
  ) => Query<Row, Params>;
  readonly fragment: <Parts extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: Parts
  ) => SqlFragment<SqlPartsParameters<Parts>>;
  readonly empty: SqlFragment<readonly []>;
  readonly ident: (name: string) => SqlFragment<readonly []>;
  readonly value: <Value>(value: Value) => SqlFragment<readonly [Value]>;
  readonly join: <const Parts extends readonly SqlFragment[]>(
    parts: Parts,
    separator?: SqlFragment<readonly []>,
  ) => SqlFragment<FragmentListParameters<Parts>>;
  readonly and: <const Parts extends readonly OptionalSqlFragment[]>(
    parts: Parts,
  ) => SqlFragment<FragmentListParameters<Parts>>;
  readonly or: <const Parts extends readonly OptionalSqlFragment[]>(
    parts: Parts,
  ) => SqlFragment<FragmentListParameters<Parts>>;
  readonly where: <Row, QueryParams extends readonly unknown[], PredicateParams extends readonly unknown[]>(
    query: Query<Row, QueryParams>,
    predicate: SqlFragment<PredicateParams>,
  ) => Query<Row, readonly [...QueryParams, ...PredicateParams]>;
  readonly append: <Row, QueryParams extends readonly unknown[], const Parts extends readonly OptionalSqlFragment[]>(
    query: Query<Row, QueryParams>,
    ...parts: Parts
  ) => Query<Row, readonly [...QueryParams, ...FragmentListParameters<Parts>]>;
  readonly raw: (text: string) => SqlFragment<readonly []>;
  readonly dynamic: (text: string) => Query<unknown>;
}

export interface SqlRenderer {
  placeholder(index: number): string;
  quoteIdentifier(name: string): string;
}

export interface RenderedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

type QueryRenderSkeletonSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value" }
  | { readonly kind: "identifier"; readonly name: string };

/**
 * An immutable rendering plan for queries that must retain one structural SQL shape.
 * Create it with {@link compileQueryRenderSkeleton}; its representation is intentionally opaque.
 */
export interface QueryRenderSkeleton {
  readonly text: string;
  readonly [queryRenderSkeletonBrand]: readonly QueryRenderSkeletonSegment[];
}

export interface QueryExecutor {
  execute(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

export interface ControlledQueryExecutor extends QueryExecutor {
  readonly executionCapabilities: ExecutionCapabilities;
  executeControlled(text: string, values: readonly unknown[], options: ExecutionOptions): Promise<readonly unknown[]>;
}

export interface Database<TransactionScope extends Database<TransactionScope> = TransactionDatabase> {
  readonly executionCapabilities: ExecutionCapabilities;
  execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]>;
  all<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]>;
  one<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, options?: ExecutionOptions): Promise<Row>;
  maybeOne<Row, Params extends readonly unknown[]>(
    query: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row | undefined>;
  transaction<T>(fn: (db: TransactionScope) => Promise<T>): Promise<T>;
}

export interface TransactionDatabase extends Database<TransactionDatabase> {}

export type TransactionRunner = <T>(fn: (executor: QueryExecutor) => Promise<T>) => Promise<T>;

const text = (textValue: string): SqlSegment => ({ kind: "text", text: textValue });
const cachedText = (textValue: string): SqlSegment => Object.freeze({ kind: "text", text: textValue });
const value = (valueItem: unknown): SqlSegment => ({ kind: "value", value: valueItem });
const fragmentTypeBrand = (): readonly unknown[] => [];
const queryTypeBrand = Object.freeze({
  row: (row: unknown): unknown => row,
  params: (params: readonly unknown[]): readonly unknown[] => params,
});

function fragment<Params extends readonly unknown[]>(segments: SqlSegment[]): SqlFragment<Params> {
  return Object.freeze({
    [fragmentBrand]: fragmentTypeBrand as () => Params,
    segments: Object.freeze(segments),
  });
}

function isFragment(part: unknown): part is SqlFragment {
  return (
    typeof part === "object" &&
    part !== null &&
    fragmentBrand in part &&
    Array.isArray((part as Partial<SqlFragment>).segments)
  );
}

function query<Row, Params extends readonly unknown[]>(segments: SqlSegment[]): Query<Row, Params> {
  return Object.freeze({
    [queryBrand]: queryTypeBrand as unknown as Query<Row, Params>[typeof queryBrand],
    segments: Object.freeze(segments),
  });
}

const templateTextCache = new WeakMap<TemplateStringsArray, readonly SqlSegment[]>();
const staticFragmentCache = new WeakMap<TemplateStringsArray, SqlFragment<readonly []>>();

function templateTextSegments(strings: TemplateStringsArray): readonly SqlSegment[] {
  const cached = templateTextCache.get(strings);
  if (cached !== undefined) return cached;
  const segments = Object.freeze(Array.from(strings, cachedText));
  templateTextCache.set(strings, segments);
  return segments;
}

function appendSegments(target: SqlSegment[], source: readonly SqlSegment[]): void {
  for (let index = 0; index < source.length; index += 1) target.push(source[index]!);
}

function templateSegments(strings: TemplateStringsArray, parts: readonly unknown[]): SqlSegment[] {
  const template = templateTextSegments(strings);
  const segments: SqlSegment[] = [];
  for (let index = 0; index < template.length; index += 1) {
    segments.push(template[index]!);
    if (index >= parts.length) continue;
    const part = parts[index];
    if (isFragment(part)) appendSegments(segments, part.segments);
    else segments.push(value(part));
  }
  return segments;
}

const tag = <Row = unknown, Parts extends readonly unknown[] = readonly unknown[]>(
  strings: TemplateStringsArray,
  ...parts: Parts
): Query<Row, SqlPartsParameters<Parts>> => {
  return query<Row, SqlPartsParameters<Parts>>(templateSegments(strings, parts));
};

const fragmentTag = <Parts extends readonly unknown[]>(
  strings: TemplateStringsArray,
  ...parts: Parts
): SqlFragment<SqlPartsParameters<Parts>> => {
  if (parts.length === 0) {
    const cached = staticFragmentCache.get(strings);
    if (cached !== undefined) return cached as SqlFragment<SqlPartsParameters<Parts>>;
    const staticFragment = fragment<SqlPartsParameters<Parts>>(templateSegments(strings, parts));
    staticFragmentCache.set(strings, staticFragment as SqlFragment<readonly []>);
    return staticFragment;
  }
  return fragment<SqlPartsParameters<Parts>>(templateSegments(strings, parts));
};

const openParenthesis = cachedText("(");
const closeParenthesis = cachedText(")");
const andSeparator = cachedText(" AND ");
const orSeparator = cachedText(" OR ");
const truePredicate = cachedText("TRUE");
const whereSeparator = cachedText(" WHERE ");

function booleanGroup<const Parts extends readonly OptionalSqlFragment[]>(
  parts: Parts,
  operator: "AND" | "OR",
): SqlFragment<FragmentListParameters<Parts>> {
  const segments: SqlSegment[] = [];
  for (const part of parts) {
    if (part === undefined || part === null || part === false) continue;
    if (!isFragment(part)) throw new TypeError(`sql.${operator.toLowerCase()}() accepts SQL fragments or empty values`);
    if (segments.length > 0) segments.push(operator === "AND" ? andSeparator : orSeparator);
    segments.push(openParenthesis);
    appendSegments(segments, part.segments);
    segments.push(closeParenthesis);
  }
  if (segments.length === 0) segments.push(truePredicate);
  return fragment<FragmentListParameters<Parts>>(segments);
}

const commaSeparator = fragment<readonly []>([text(", ")]);

export const sql: SqlTag = Object.assign(tag, {
  __typed<Row, Params extends readonly unknown[]>() {
    return <const Parts extends readonly unknown[]>(
      strings: TemplateStringsArray,
      ...parts: CheckedSqlParts<Parts, Params>
    ) => tag<Row, Parts>(strings, ...(parts as unknown as Parts)) as unknown as Query<Row, Params>;
  },
  fragment: fragmentTag,
  empty: fragment<readonly []>([]),
  ident(name: string): SqlFragment<readonly []> {
    if (name.length === 0 || name.includes("\0"))
      throw new TypeError("SQL identifiers must be non-empty and cannot contain NUL");
    return fragment<readonly []>([{ kind: "identifier", name }]);
  },
  value<Value>(valueItem: Value): SqlFragment<readonly [Value]> {
    return fragment<readonly [Value]>([value(valueItem)]);
  },
  join<const Parts extends readonly SqlFragment[]>(
    parts: Parts,
    separator: SqlFragment<readonly []> = commaSeparator,
  ): SqlFragment<FragmentListParameters<Parts>> {
    if (!isFragment(separator)) throw new TypeError("sql.join() separator must be a trusted SQL fragment");
    const segments: SqlSegment[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (!isFragment(part)) throw new TypeError("sql.join() accepts SQL fragments");
      if (index > 0) appendSegments(segments, separator.segments);
      appendSegments(segments, part.segments);
    }
    return fragment<FragmentListParameters<Parts>>(segments);
  },
  and<const Parts extends readonly OptionalSqlFragment[]>(parts: Parts): SqlFragment<FragmentListParameters<Parts>> {
    return booleanGroup(parts, "AND");
  },
  or<const Parts extends readonly OptionalSqlFragment[]>(parts: Parts): SqlFragment<FragmentListParameters<Parts>> {
    return booleanGroup(parts, "OR");
  },
  where<Row, QueryParams extends readonly unknown[], PredicateParams extends readonly unknown[]>(
    queryValue: Query<Row, QueryParams>,
    predicate: SqlFragment<PredicateParams>,
  ): Query<Row, readonly [...QueryParams, ...PredicateParams]> {
    const segments: SqlSegment[] = [];
    appendSegments(segments, queryValue.segments);
    segments.push(whereSeparator);
    appendSegments(segments, predicate.segments);
    return query<Row, readonly [...QueryParams, ...PredicateParams]>(segments);
  },
  append<Row, QueryParams extends readonly unknown[], const Parts extends readonly OptionalSqlFragment[]>(
    queryValue: Query<Row, QueryParams>,
    ...parts: Parts
  ): Query<Row, readonly [...QueryParams, ...FragmentListParameters<Parts>]> {
    const segments: SqlSegment[] = [];
    appendSegments(segments, queryValue.segments);
    for (const part of parts) {
      if (part === undefined || part === null || part === false) continue;
      if (!isFragment(part)) throw new TypeError("sql.append() accepts SQL fragments or empty values");
      appendSegments(segments, part.segments);
    }
    return query<Row, readonly [...QueryParams, ...FragmentListParameters<Parts>]>(segments);
  },
  raw(sqlText: string): SqlFragment<readonly []> {
    return fragment<readonly []>([text(sqlText)]);
  },
  dynamic(sqlText: string): Query<unknown> {
    return query<unknown, readonly unknown[]>([text(sqlText)]);
  },
}) satisfies SqlTag;

export function renderQuery<Row, Params extends readonly unknown[]>(
  queryValue: Query<Row, Params>,
  renderer: SqlRenderer,
): RenderedQuery {
  const values: unknown[] = [];
  const chunks: string[] = [];
  for (const segment of queryValue.segments) {
    if (segment.kind === "text") chunks.push(segment.text);
    else if (segment.kind === "identifier") chunks.push(renderer.quoteIdentifier(segment.name));
    else {
      values.push(segment.value);
      chunks.push(renderer.placeholder(values.length));
    }
  }
  return { text: chunks.join(""), values: Object.freeze(values) };
}

/**
 * Renders a query and compiles an immutable structural plan that can bind later values without
 * quoting identifiers, formatting placeholders, or rebuilding the SQL text.
 */
export function compileQueryRenderSkeleton<Row, Params extends readonly unknown[]>(
  queryValue: Query<Row, Params>,
  renderer: SqlRenderer,
): { readonly skeleton: QueryRenderSkeleton; readonly rendered: RenderedQuery } {
  const values: unknown[] = [];
  const chunks: string[] = [];
  const skeletonSegments: QueryRenderSkeletonSegment[] = [];
  for (const segment of queryValue.segments) {
    if (segment.kind === "text") {
      chunks.push(segment.text);
      skeletonSegments.push(Object.freeze({ kind: "text", text: segment.text }));
    } else if (segment.kind === "identifier") {
      chunks.push(renderer.quoteIdentifier(segment.name));
      skeletonSegments.push(Object.freeze({ kind: "identifier", name: segment.name }));
    } else {
      values.push(segment.value);
      chunks.push(renderer.placeholder(values.length));
      skeletonSegments.push(Object.freeze({ kind: "value" }));
    }
  }
  const textValue = chunks.join("");
  return {
    skeleton: Object.freeze({
      text: textValue,
      [queryRenderSkeletonBrand]: Object.freeze(skeletonSegments),
    }),
    rendered: { text: textValue, values: Object.freeze(values) },
  };
}

/**
 * Binds the values of a query to a previously compiled skeleton. Returns `undefined` when the
 * segment count, segment kinds, structural text, or identifier names have drifted.
 */
export function bindQueryRenderSkeleton<Row, Params extends readonly unknown[]>(
  queryValue: Query<Row, Params>,
  skeleton: QueryRenderSkeleton,
): RenderedQuery | undefined {
  const querySegments = queryValue.segments;
  const skeletonSegments = skeleton[queryRenderSkeletonBrand];
  if (querySegments.length !== skeletonSegments.length) return undefined;

  const values: unknown[] = [];
  for (let index = 0; index < querySegments.length; index += 1) {
    const segment = querySegments[index]!;
    const skeletonSegment = skeletonSegments[index]!;
    if (skeletonSegment.kind === "text") {
      if (segment.kind !== "text" || segment.text !== skeletonSegment.text) return undefined;
    } else if (skeletonSegment.kind === "identifier") {
      if (segment.kind !== "identifier" || segment.name !== skeletonSegment.name) return undefined;
    } else {
      if (segment.kind !== "value") return undefined;
      values.push(segment.value);
    }
  }
  return { text: skeleton.text, values: Object.freeze(values) };
}

class DatabaseImplementation implements Database {
  readonly #executor: QueryExecutor;
  readonly #renderer: SqlRenderer;
  readonly #transactionRunner: TransactionRunner | undefined;
  readonly executionCapabilities: ExecutionCapabilities;

  constructor(executor: QueryExecutor, renderer: SqlRenderer, transactionRunner?: TransactionRunner) {
    this.#executor = executor;
    this.#renderer = renderer;
    this.#transactionRunner = transactionRunner;
    this.executionCapabilities = Object.freeze(
      "executeControlled" in executor
        ? { ...(executor as ControlledQueryExecutor).executionCapabilities }
        : { cancellation: false, deadlines: false },
    );
  }

  async execute<Row, Params extends readonly unknown[]>(queryValue: Query<Row, Params>): Promise<readonly Row[]> {
    const rendered = renderQuery(queryValue, this.#renderer);
    return (await this.#executor.execute(rendered.text, rendered.values)) as readonly Row[];
  }

  async all<Row, Params extends readonly unknown[]>(
    queryValue: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<readonly Row[]> {
    if (options === undefined || (options.signal === undefined && options.deadline === undefined)) {
      return this.execute(queryValue);
    }
    assertExecutionCapabilities(this.executionCapabilities, options);
    const controlled = this.#executor as ControlledQueryExecutor;
    const rendered = renderQuery(queryValue, this.#renderer);
    return (await controlled.executeControlled(rendered.text, rendered.values, options)) as readonly Row[];
  }

  async one<Row, Params extends readonly unknown[]>(
    queryValue: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row> {
    const rows = await this.all(queryValue, options);
    if (rows.length !== 1) throw new QueryCardinalityError("one", rows.length);
    return rows[0]!;
  }

  async maybeOne<Row, Params extends readonly unknown[]>(
    queryValue: Query<Row, Params>,
    options?: ExecutionOptions,
  ): Promise<Row | undefined> {
    const rows = await this.all(queryValue, options);
    if (rows.length > 1) throw new QueryCardinalityError("maybeOne", rows.length);
    return rows[0];
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    if (this.#transactionRunner === undefined) throw new Error("This database adapter does not support transactions");
    return this.#transactionRunner(async (executor) =>
      fn(new DatabaseImplementation(executor, this.#renderer, this.#transactionRunner)),
    );
  }
}

export function createDatabase(
  executor: QueryExecutor,
  renderer: SqlRenderer,
  transactionRunner?: TransactionRunner,
): Database {
  return new DatabaseImplementation(executor, renderer, transactionRunner);
}
