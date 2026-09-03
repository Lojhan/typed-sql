import {
  assertExecutionCapabilities,
  type ExecutionCapabilities,
  type ExecutionOptions,
  QueryCardinalityError,
} from "./execution.js";
import {
  type CompatibleResultSchema,
  type QueryResultValidationOptions,
  queryResultValidationSource,
  type StandardSchemaV1,
  setQueryResultValidator,
  validateQueryResultRows,
} from "./result-validation.js";

const fragmentBrand: unique symbol = Symbol.for("@typed-sql/core.fragment") as never;
const queryBrand: unique symbol = Symbol.for("@typed-sql/core.query") as never;
const queryRenderSkeletonBrand: unique symbol = Symbol("@typed-sql/core.query-render-skeleton");

export type SqlSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "identifier"; readonly name: string }
  | FragmentListSegment;

interface FragmentListSegment {
  readonly kind: "fragment-list";
  readonly items: readonly SqlFragment[];
  readonly separator: SqlFragment<readonly []>;
}

export const DEFAULT_MAX_FRAGMENT_LIST_ITEMS = 10_000;
export const DEFAULT_MAX_QUERY_PARAMETERS = 65_535;
export const DEFAULT_MAX_RENDERED_SQL_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS = 32;

export type SqlFragmentListErrorCode =
  | "TSQL_FRAGMENT_LIST_ASYNC"
  | "TSQL_FRAGMENT_LIST_EMPTY"
  | "TSQL_FRAGMENT_LIST_LIMIT"
  | "TSQL_FRAGMENT_LIST_MIXED"
  | "TSQL_FRAGMENT_LIST_NESTED"
  | "TSQL_FRAGMENT_LIST_SPARSE";

export class SqlFragmentListError extends TypeError {
  readonly code: SqlFragmentListErrorCode;

  constructor(code: SqlFragmentListErrorCode, message: string) {
    super(message);
    this.name = "SqlFragmentListError";
    this.code = code;
  }
}

export interface SqlFragment<Params extends readonly unknown[] = readonly unknown[]> {
  readonly [fragmentBrand]: () => Params;
  readonly segments: readonly SqlSegment[];
}

export type QueryRow<Value> = Value extends Query<infer Row, infer _Params> ? Row : never;
export type QueryParameters<Value> = Value extends Query<infer _Row, infer Params> ? Params : never;

type IsAny<Value> = 0 extends 1 & Value ? true : false;

type FragmentTupleParameters<
  Parts extends readonly unknown[],
  Accumulator extends readonly unknown[] = readonly [],
> = Parts extends readonly [infer Head, ...infer Tail]
  ? [Head] extends [SqlFragment<infer Params>]
    ? FragmentTupleParameters<Tail, readonly [...Accumulator, ...Params]>
    : never
  : Accumulator;

type FragmentArrayParameters<Parts extends readonly unknown[]> = number extends Parts["length"]
  ? [Parts[number]] extends [SqlFragment<infer Params>]
    ? readonly Params[number][]
    : never
  : FragmentTupleParameters<Parts>;

type SqlArrayPartParameters<Part extends readonly unknown[]> = Part extends readonly []
  ? never
  : [Part[number]] extends [never]
    ? never
    : IsAny<Part[number]> extends true
      ? never
      : [Part[number]] extends [SqlFragment]
        ? FragmentArrayParameters<Part>
        : [Extract<Part[number], SqlFragment>] extends [never]
          ? [Extract<Part[number], readonly unknown[] | PromiseLike<unknown>>] extends [never]
            ? readonly [Part]
            : never
          : never;

type SqlPartParameters<Part> = [Part] extends [SqlFragment<infer Params>]
  ? Params
  : [Part] extends [readonly unknown[]]
    ? SqlArrayPartParameters<Part>
    : readonly [Part];

export type SqlPartsParameters<
  Parts extends readonly unknown[],
  Accumulator extends readonly unknown[] = readonly [],
> = number extends Parts["length"]
  ? readonly unknown[]
  : Parts extends readonly [infer Head, ...infer Tail]
    ? SqlPartsParameters<Tail, readonly [...Accumulator, ...SqlPartParameters<Head>]>
    : Accumulator;

type HasInvalidSqlPart<Parts extends readonly unknown[]> = number extends Parts["length"]
  ? false
  : Parts extends readonly [infer Head, ...infer Tail]
    ? [SqlPartParameters<Head>] extends [never]
      ? true
      : HasInvalidSqlPart<Tail>
    : false;

type CheckedTemplateParts<Parts extends readonly unknown[]> = Parts &
  (HasInvalidSqlPart<Parts> extends true ? never : unknown);

type CheckedSqlParts<
  Parts extends readonly unknown[],
  Expected extends readonly unknown[],
> = CheckedTemplateParts<Parts> & ([SqlPartsParameters<Parts>] extends [Expected] ? unknown : never);

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
    ...parts: CheckedTemplateParts<Parts>
  ): Query<Row, SqlPartsParameters<Parts>>;
  /**
   * @internal Reserved compiler-overlay protocol. Applications must use the `sql` tag directly;
   * this member may change alongside matching core/compiler releases without application-level compatibility.
   */
  readonly __typed: <Row, Params extends readonly unknown[]>() => <const Parts extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: CheckedSqlParts<Parts, Params>
  ) => Query<Row, Params>;
  /** @internal Reserved compiler overlay that preserves interpolation-derived parameter types. */
  readonly __typedRow: <Row>() => <Parts extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: CheckedTemplateParts<Parts>
  ) => Query<Row, SqlPartsParameters<Parts>>;
  readonly fragment: <Parts extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: CheckedTemplateParts<Parts>
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
  readonly validateResult: <Row, Params extends readonly unknown[], const Schema extends StandardSchemaV1>(
    query: Query<Row, Params>,
    schema: Schema & CompatibleResultSchema<Row, Schema>,
    options?: QueryResultValidationOptions,
  ) => Query<StandardSchemaV1.InferOutput<Schema>, Params>;
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

export interface PreparedQueryRenderVariant {
  readonly rendered: RenderedQuery;
  /** The first rendered SQL text in this structural family. */
  readonly primary: boolean;
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

const commaSeparator = fragment<readonly []>([text(", ")]);

function isPromiseLike(valueItem: unknown): boolean {
  return (
    (typeof valueItem === "object" || typeof valueItem === "function") &&
    valueItem !== null &&
    typeof (valueItem as { readonly then?: unknown }).then === "function"
  );
}

function classifyArrayPart(part: readonly unknown[]): SqlSegment {
  if (part.length === 0) {
    throw new SqlFragmentListError(
      "TSQL_FRAGMENT_LIST_EMPTY",
      "An empty interpolated array is ambiguous; use sql.value([]), sql.join(...), or sql.empty explicitly",
    );
  }
  let fragmentCount = 0;
  for (let index = 0; index < part.length; index += 1) {
    if (!(index in part)) {
      throw new SqlFragmentListError(
        "TSQL_FRAGMENT_LIST_SPARSE",
        "Sparse interpolated arrays are unsupported; build a dense value array or fragment list",
      );
    }
    const item = part[index];
    if (Array.isArray(item)) {
      throw new SqlFragmentListError(
        "TSQL_FRAGMENT_LIST_NESTED",
        "Nested interpolated arrays are ambiguous; wrap the complete value with sql.value(...) or flatten fragments explicitly",
      );
    }
    if (isPromiseLike(item)) {
      throw new SqlFragmentListError(
        "TSQL_FRAGMENT_LIST_ASYNC",
        "Promise elements cannot form SQL; resolve values before interpolation and use a synchronous fragment callback",
      );
    }
    if (isFragment(item)) fragmentCount += 1;
  }
  if (fragmentCount === 0) return value(part);
  if (fragmentCount !== part.length) {
    throw new SqlFragmentListError(
      "TSQL_FRAGMENT_LIST_MIXED",
      "An interpolated array cannot mix SQL fragments and values; use an all-fragment list or sql.value(...) explicitly",
    );
  }
  if (part.length > DEFAULT_MAX_FRAGMENT_LIST_ITEMS) {
    throw new SqlFragmentListError(
      "TSQL_FRAGMENT_LIST_LIMIT",
      `Fragment list contains ${part.length} items; the limit is ${DEFAULT_MAX_FRAGMENT_LIST_ITEMS}`,
    );
  }
  const items = part as readonly SqlFragment[];
  return Object.freeze({
    kind: "fragment-list",
    items: Object.freeze([...items]),
    separator: commaSeparator,
  });
}

function templateSegments(strings: TemplateStringsArray, parts: readonly unknown[]): SqlSegment[] {
  const template = templateTextSegments(strings);
  const segments: SqlSegment[] = [];
  for (let index = 0; index < template.length; index += 1) {
    segments.push(template[index]!);
    if (index >= parts.length) continue;
    const part = parts[index];
    if (isFragment(part)) appendSegments(segments, part.segments);
    else if (Array.isArray(part)) segments.push(classifyArrayPart(part));
    else segments.push(value(part));
  }
  return segments;
}

const tag = <Row = unknown, Parts extends readonly unknown[] = readonly unknown[]>(
  strings: TemplateStringsArray,
  ...parts: CheckedTemplateParts<Parts>
): Query<Row, SqlPartsParameters<Parts>> => {
  return query<Row, SqlPartsParameters<Parts>>(templateSegments(strings, parts));
};

const fragmentTag = <Parts extends readonly unknown[]>(
  strings: TemplateStringsArray,
  ...parts: CheckedTemplateParts<Parts>
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

export const sql: SqlTag = Object.assign(tag, {
  __typed<Row, Params extends readonly unknown[]>() {
    return <const Parts extends readonly unknown[]>(
      strings: TemplateStringsArray,
      ...parts: CheckedSqlParts<Parts, Params>
    ) => query<Row, Params>(templateSegments(strings, parts));
  },
  __typedRow<Row>() {
    return <Parts extends readonly unknown[]>(
      strings: TemplateStringsArray,
      ...parts: CheckedTemplateParts<Parts>
    ): Query<Row, SqlPartsParameters<Parts>> => query<Row, SqlPartsParameters<Parts>>(templateSegments(strings, parts));
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
  validateResult<Row, Params extends readonly unknown[], const Schema extends StandardSchemaV1>(
    queryValue: Query<Row, Params>,
    schema: Schema,
    options: QueryResultValidationOptions = {},
  ): Query<StandardSchemaV1.InferOutput<Schema>, Params> {
    const standard = schema?.["~standard"];
    if (
      typeof standard !== "object" ||
      standard === null ||
      standard.version !== 1 ||
      typeof standard.vendor !== "string" ||
      typeof standard.validate !== "function"
    ) {
      throw new TypeError("sql.validateResult() expects a Standard Schema V1 validator");
    }
    const validated = query<StandardSchemaV1.InferOutput<Schema>, Params>([...queryValue.segments]);
    setQueryResultValidator(validated, queryResultValidationSource(queryValue), schema, options);
    return validated;
  },
  raw(sqlText: string): SqlFragment<readonly []> {
    return fragment<readonly []>([text(sqlText)]);
  },
  dynamic(sqlText: string): Query<unknown> {
    return query<unknown, readonly unknown[]>([text(sqlText)]);
  },
}) satisfies SqlTag;

type SqlStructure =
  | readonly ["text", string]
  | readonly ["value"]
  | readonly ["identifier", string]
  | readonly ["fragment-list", readonly SqlStructure[], readonly SqlStructure[]]
  | readonly ["fixed-fragment-list", readonly (readonly SqlStructure[])[], readonly SqlStructure[]];

function segmentStructure(segments: readonly SqlSegment[]): readonly SqlStructure[] {
  return segments.map((segment): SqlStructure => {
    if (segment.kind === "text") return ["text", segment.text];
    if (segment.kind === "value") return ["value"];
    if (segment.kind === "identifier") return ["identifier", segment.name];
    const items = segment.items.map((item) => segmentStructure(item.segments));
    const first = JSON.stringify(items[0]);
    return items.every((item) => JSON.stringify(item) === first)
      ? ["fragment-list", items[0]!, segmentStructure(segment.separator.segments)]
      : ["fixed-fragment-list", items, segmentStructure(segment.separator.segments)];
  });
}

export function renderQuery<Row, Params extends readonly unknown[]>(
  queryValue: Query<Row, Params>,
  renderer: SqlRenderer,
): RenderedQuery {
  const segments = queryValue.segments;
  assertQueryResourceLimits(segments);
  const values: unknown[] = [];
  const chunks: string[] = [];
  let sqlBytes = 0;
  visitSegments(segments, (segment) => {
    let chunk: string;
    if (segment.kind === "text") chunk = segment.text;
    else if (segment.kind === "identifier") chunk = renderer.quoteIdentifier(segment.name);
    else {
      values.push(segment.value);
      chunk = renderer.placeholder(values.length);
    }
    sqlBytes += Buffer.byteLength(chunk);
    if (sqlBytes > DEFAULT_MAX_RENDERED_SQL_BYTES) {
      throw new SqlFragmentListError(
        "TSQL_FRAGMENT_LIST_LIMIT",
        `Rendered SQL exceeds the ${DEFAULT_MAX_RENDERED_SQL_BYTES}-byte limit after fragment-list expansion`,
      );
    }
    chunks.push(chunk);
  });
  return { text: chunks.join(""), values: Object.freeze(values) };
}

function visitSegments(
  segments: readonly SqlSegment[],
  visit: (segment: Exclude<SqlSegment, FragmentListSegment>) => void,
): void {
  for (const segment of segments) {
    if (segment.kind !== "fragment-list") {
      visit(segment);
      continue;
    }
    for (let index = 0; index < segment.items.length; index += 1) {
      if (index > 0) visitSegments(segment.separator.segments, visit);
      visitSegments(segment.items[index]!.segments, visit);
    }
  }
}

function expandedSegments(segments: readonly SqlSegment[]): readonly Exclude<SqlSegment, FragmentListSegment>[] {
  const result: Exclude<SqlSegment, FragmentListSegment>[] = [];
  visitSegments(segments, (segment) => result.push(segment));
  return result;
}

function assertQueryResourceLimits(segments: readonly SqlSegment[]): void {
  let parameters = 0;
  let sqlBytes = 0;
  visitSegments(segments, (segment) => {
    if (segment.kind === "value") {
      parameters += 1;
      sqlBytes += String(parameters).length + 1;
    } else {
      sqlBytes += segment.kind === "text" ? Buffer.byteLength(segment.text) : Buffer.byteLength(segment.name) + 2;
    }
    if (parameters > DEFAULT_MAX_QUERY_PARAMETERS) {
      throw new SqlFragmentListError(
        "TSQL_FRAGMENT_LIST_LIMIT",
        `Query contains more than ${DEFAULT_MAX_QUERY_PARAMETERS} parameters after fragment-list expansion`,
      );
    }
    if (sqlBytes > DEFAULT_MAX_RENDERED_SQL_BYTES) {
      throw new SqlFragmentListError(
        "TSQL_FRAGMENT_LIST_LIMIT",
        `Rendered SQL exceeds the ${DEFAULT_MAX_RENDERED_SQL_BYTES}-byte limit after fragment-list expansion`,
      );
    }
  });
}

/**
 * Renders a query and compiles an immutable structural plan that can bind later values without
 * quoting identifiers, formatting placeholders, or rebuilding the SQL text.
 */
export function compileQueryRenderSkeleton<Row, Params extends readonly unknown[]>(
  queryValue: Query<Row, Params>,
  renderer: SqlRenderer,
): { readonly skeleton: QueryRenderSkeleton; readonly rendered: RenderedQuery } {
  return compileRenderSkeletonSegments(queryValue.segments, renderer);
}

function compileRenderSkeletonSegments(
  segments: readonly SqlSegment[],
  renderer: SqlRenderer,
): { readonly skeleton: QueryRenderSkeleton; readonly rendered: RenderedQuery } {
  assertQueryResourceLimits(segments);
  const values: unknown[] = [];
  const chunks: string[] = [];
  let sqlBytes = 0;
  const skeletonSegments: QueryRenderSkeletonSegment[] = [];
  for (const segment of expandedSegments(segments)) {
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
    sqlBytes += Buffer.byteLength(chunks[chunks.length - 1]!);
    if (sqlBytes > DEFAULT_MAX_RENDERED_SQL_BYTES) {
      throw new SqlFragmentListError(
        "TSQL_FRAGMENT_LIST_LIMIT",
        `Rendered SQL exceeds the ${DEFAULT_MAX_RENDERED_SQL_BYTES}-byte limit after fragment-list expansion`,
      );
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
  return bindRenderSkeletonSegments(queryValue.segments, skeleton);
}

function bindRenderSkeletonSegments(
  segments: readonly SqlSegment[],
  skeleton: QueryRenderSkeleton,
): RenderedQuery | undefined {
  assertQueryResourceLimits(segments);
  const querySegments = expandedSegments(segments);
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

/**
 * Bounded LRU of rendered cardinality variants for one prepared-query structural family.
 * Fragment-list item counts may vary; all other SQL structure must remain identical.
 */
export class PreparedQueryRenderCache {
  readonly capacity: number;
  #family: string | undefined;
  #primaryText: string | undefined;
  readonly #skeletons: QueryRenderSkeleton[] = [];

  constructor(capacity = DEFAULT_MAX_PREPARED_CARDINALITY_VARIANTS) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("Prepared cardinality variant limit must be a positive safe integer");
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.#skeletons.length;
  }

  bind<Row, Params extends readonly unknown[]>(
    queryValue: Query<Row, Params>,
    renderer: SqlRenderer,
  ): PreparedQueryRenderVariant | undefined {
    const segments = queryValue.segments;
    const family = JSON.stringify(segmentStructure(segments));
    if (this.#family !== undefined && this.#family !== family) return undefined;
    this.#family ??= family;

    for (let index = 0; index < this.#skeletons.length; index += 1) {
      const skeleton = this.#skeletons[index]!;
      const rendered = bindRenderSkeletonSegments(segments, skeleton);
      if (rendered === undefined) continue;
      if (index !== this.#skeletons.length - 1) {
        this.#skeletons.splice(index, 1);
        this.#skeletons.push(skeleton);
      }
      return Object.freeze({ rendered, primary: rendered.text === this.#primaryText });
    }

    const compiled = compileRenderSkeletonSegments(segments, renderer);
    this.#primaryText ??= compiled.rendered.text;
    if (this.#skeletons.length === this.capacity) this.#skeletons.shift();
    this.#skeletons.push(compiled.skeleton);
    return Object.freeze({ rendered: compiled.rendered, primary: compiled.rendered.text === this.#primaryText });
  }
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
    const rows = await this.#executor.execute(rendered.text, rendered.values);
    return validateQueryResultRows(queryValue, rows, "generic-adapter");
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
    const rows = await controlled.executeControlled(rendered.text, rendered.values, options);
    return validateQueryResultRows(queryValue, rows, "generic-adapter");
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
