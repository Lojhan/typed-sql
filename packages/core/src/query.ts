const fragmentBrand: unique symbol = Symbol("typed-sql.fragment");
const queryBrand: unique symbol = Symbol("typed-sql.query");

export type SqlSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "identifier"; readonly name: string };

export interface SqlFragment {
  readonly [fragmentBrand]: true;
  readonly segments: readonly SqlSegment[];
}

export interface Query<Row> {
  readonly [queryBrand]: (value: Row) => Row;
  readonly segments: readonly SqlSegment[];
}

export interface SqlTag {
  <Row = unknown>(strings: TemplateStringsArray, ...parts: readonly unknown[]): Query<Row>;
  readonly ident: (name: string) => SqlFragment;
  readonly value: (value: unknown) => SqlFragment;
  readonly join: (parts: readonly SqlFragment[], separator?: string) => SqlFragment;
  readonly raw: (text: string) => SqlFragment;
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
  execute<Row>(query: Query<Row>): Promise<readonly Row[]>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}

export type TransactionRunner = <T>(fn: (executor: QueryExecutor) => Promise<T>) => Promise<T>;

const text = (textValue: string): SqlSegment => ({ kind: "text", text: textValue });
const value = (valueItem: unknown): SqlSegment => ({ kind: "value", value: valueItem });

function fragment(segments: readonly SqlSegment[]): SqlFragment {
  return Object.freeze({ [fragmentBrand]: true as const, segments: Object.freeze([...segments]) });
}

function isFragment(part: unknown): part is SqlFragment {
  return typeof part === "object" && part !== null && fragmentBrand in part;
}

function query<Row>(segments: readonly SqlSegment[]): Query<Row> {
  return Object.freeze({ [queryBrand]: (row: Row): Row => row, segments: Object.freeze([...segments]) });
}

const tag = <Row = unknown>(strings: TemplateStringsArray, ...parts: readonly unknown[]): Query<Row> => {
  const segments: SqlSegment[] = [];
  for (let index = 0; index < strings.length; index += 1) {
    segments.push(text(strings[index] ?? ""));
    if (index < parts.length) {
      const part = parts[index];
      if (isFragment(part)) segments.push(...part.segments);
      else segments.push(value(part));
    }
  }
  return query<Row>(segments);
};

export const sql: SqlTag = Object.assign(tag, {
  ident(name: string): SqlFragment {
    if (name.length === 0 || name.includes("\0")) throw new TypeError("SQL identifiers must be non-empty and cannot contain NUL");
    return fragment([{ kind: "identifier", name }]);
  },
  value(valueItem: unknown): SqlFragment { return fragment([value(valueItem)]); },
  join(parts: readonly SqlFragment[], separator = ", "): SqlFragment {
    const segments: SqlSegment[] = [];
    parts.forEach((part, index) => {
      if (index > 0) segments.push(text(separator));
      segments.push(...part.segments);
    });
    return fragment(segments);
  },
  raw(sqlText: string): SqlFragment { return fragment([text(sqlText)]); },
  dynamic(sqlText: string): Query<unknown> { return query<unknown>([text(sqlText)]); },
}) satisfies SqlTag;

export function renderQuery<Row>(queryValue: Query<Row>, renderer: SqlRenderer): RenderedQuery {
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

  async execute<Row>(queryValue: Query<Row>): Promise<readonly Row[]> {
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
