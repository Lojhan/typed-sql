const fragmentBrand: unique symbol = Symbol("typed-sql.fragment");
const queryBrand: unique symbol = Symbol("typed-sql.query");

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
  readonly withRow: <Row>() => <Parts extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: Parts
  ) => Query<Row, SqlPartsParameters<Parts>>;
  readonly fragment: <Parts extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parts: Parts
  ) => SqlFragment<SqlPartsParameters<Parts>>;
  readonly empty: SqlFragment<readonly []>;
  readonly ident: (name: string) => SqlFragment<readonly []>;
  readonly value: <Value>(value: Value) => SqlFragment<readonly [Value]>;
  readonly join: <const Parts extends readonly SqlFragment[]>(
    parts: Parts,
    separator?: string,
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

export interface QueryExecutor {
  execute(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

export interface Database {
  execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}

export type TransactionRunner = <T>(fn: (executor: QueryExecutor) => Promise<T>) => Promise<T>;

const text = (textValue: string): SqlSegment => ({ kind: "text", text: textValue });
const value = (valueItem: unknown): SqlSegment => ({ kind: "value", value: valueItem });

function fragment<Params extends readonly unknown[]>(segments: readonly SqlSegment[]): SqlFragment<Params> {
  return Object.freeze({
    [fragmentBrand]: (): Params => [] as unknown as Params,
    segments: Object.freeze([...segments]),
  });
}

function isFragment(part: unknown): part is SqlFragment {
  return typeof part === "object" && part !== null && fragmentBrand in part;
}

function query<Row, Params extends readonly unknown[]>(segments: readonly SqlSegment[]): Query<Row, Params> {
  return Object.freeze({
    [queryBrand]: Object.freeze({
      row: (row: Row): Row => row,
      params: (params: Params): Params => params,
    }),
    segments: Object.freeze([...segments]),
  });
}

const tag = <Row = unknown, Parts extends readonly unknown[] = readonly unknown[]>(
  strings: TemplateStringsArray,
  ...parts: Parts
): Query<Row, SqlPartsParameters<Parts>> => {
  const segments: SqlSegment[] = [];
  for (let index = 0; index < strings.length; index += 1) {
    segments.push(text(strings[index] ?? ""));
    if (index < parts.length) {
      const part = parts[index];
      if (isFragment(part)) segments.push(...part.segments);
      else segments.push(value(part));
    }
  }
  return query<Row, SqlPartsParameters<Parts>>(segments);
};

const fragmentTag = <Parts extends readonly unknown[]>(
  strings: TemplateStringsArray,
  ...parts: Parts
): SqlFragment<SqlPartsParameters<Parts>> => {
  const segments: SqlSegment[] = [];
  for (let index = 0; index < strings.length; index += 1) {
    segments.push(text(strings[index] ?? ""));
    if (index < parts.length) {
      const part = parts[index];
      if (isFragment(part)) segments.push(...part.segments);
      else segments.push(value(part));
    }
  }
  return fragment<SqlPartsParameters<Parts>>(segments);
};

function booleanGroup<const Parts extends readonly OptionalSqlFragment[]>(
  parts: Parts,
  operator: "AND" | "OR",
): SqlFragment<FragmentListParameters<Parts>> {
  const segments: SqlSegment[] = [];
  for (const part of parts) {
    if (part === undefined || part === null || part === false) continue;
    if (!isFragment(part)) throw new TypeError(`sql.${operator.toLowerCase()}() accepts SQL fragments or empty values`);
    if (segments.length > 0) segments.push(text(` ${operator} `));
    segments.push(text("("), ...part.segments, text(")"));
  }
  if (segments.length === 0) segments.push(text("TRUE"));
  return fragment<FragmentListParameters<Parts>>(segments);
}

export const sql: SqlTag = Object.assign(tag, {
  withRow<Row>() {
    return <Parts extends readonly unknown[]>(strings: TemplateStringsArray, ...parts: Parts) =>
      tag<Row, Parts>(strings, ...parts);
  },
  fragment: fragmentTag,
  empty: fragment<readonly []>([]),
  ident(name: string): SqlFragment<readonly []> {
    if (name.length === 0 || name.includes("\0")) throw new TypeError("SQL identifiers must be non-empty and cannot contain NUL");
    return fragment<readonly []>([{ kind: "identifier", name }]);
  },
  value<Value>(valueItem: Value): SqlFragment<readonly [Value]> {
    return fragment<readonly [Value]>([value(valueItem)]);
  },
  join<const Parts extends readonly SqlFragment[]>(parts: Parts, separator = ", "): SqlFragment<FragmentListParameters<Parts>> {
    const segments: SqlSegment[] = [];
    parts.forEach((part, index) => {
      if (index > 0) segments.push(text(separator));
      segments.push(...part.segments);
    });
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
    return query<Row, readonly [...QueryParams, ...PredicateParams]>([
      ...queryValue.segments,
      text(" WHERE "),
      ...predicate.segments,
    ]);
  },
  append<Row, QueryParams extends readonly unknown[], const Parts extends readonly OptionalSqlFragment[]>(
    queryValue: Query<Row, QueryParams>,
    ...parts: Parts
  ): Query<Row, readonly [...QueryParams, ...FragmentListParameters<Parts>]> {
    const segments: SqlSegment[] = [...queryValue.segments];
    for (const part of parts) {
      if (part === undefined || part === null || part === false) continue;
      if (!isFragment(part)) throw new TypeError("sql.append() accepts SQL fragments or empty values");
      segments.push(...part.segments);
    }
    return query<Row, readonly [...QueryParams, ...FragmentListParameters<Parts>]>(segments);
  },
  raw(sqlText: string): SqlFragment<readonly []> { return fragment<readonly []>([text(sqlText)]); },
  dynamic(sqlText: string): Query<unknown> { return query<unknown, readonly unknown[]>([text(sqlText)]); },
}) satisfies SqlTag;

export function renderQuery<Row, Params extends readonly unknown[]>(
  queryValue: Query<Row, Params>,
  renderer: SqlRenderer,
): RenderedQuery {
  const values: unknown[] = [];
  let queryText = "";
  for (const segment of queryValue.segments) {
    if (segment.kind === "text") queryText += segment.text;
    else if (segment.kind === "identifier") queryText += renderer.quoteIdentifier(segment.name);
    else {
      values.push(segment.value);
      queryText += renderer.placeholder(values.length);
    }
  }
  return { text: queryText, values: Object.freeze(values) };
}

class DatabaseImplementation implements Database {
  readonly #executor: QueryExecutor;
  readonly #renderer: SqlRenderer;
  readonly #transactionRunner: TransactionRunner | undefined;

  constructor(executor: QueryExecutor, renderer: SqlRenderer, transactionRunner?: TransactionRunner) {
    this.#executor = executor;
    this.#renderer = renderer;
    this.#transactionRunner = transactionRunner;
  }

  async execute<Row, Params extends readonly unknown[]>(queryValue: Query<Row, Params>): Promise<readonly Row[]> {
    const rendered = renderQuery(queryValue, this.#renderer);
    return await this.#executor.execute(rendered.text, rendered.values) as readonly Row[];
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    if (this.#transactionRunner === undefined) throw new Error("This database adapter does not support transactions");
    return this.#transactionRunner(async (executor) => fn(new DatabaseImplementation(executor, this.#renderer, this.#transactionRunner)));
  }
}

export function createDatabase(executor: QueryExecutor, renderer: SqlRenderer, transactionRunner?: TransactionRunner): Database {
  return new DatabaseImplementation(executor, renderer, transactionRunner);
}
