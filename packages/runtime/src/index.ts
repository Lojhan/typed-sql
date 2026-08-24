import { parseSelect, type SelectStatement } from "@typed-sql/ast";

const fragmentBrand: unique symbol = Symbol("typed-sql.fragment");

interface TextSegment {
  readonly kind: "text";
  readonly text: string;
}

interface ValueSegment {
  readonly kind: "value";
  readonly value: unknown;
}

type Segment = TextSegment | ValueSegment;

export interface SqlFragment {
  readonly [fragmentBrand]: true;
  readonly segments: readonly Segment[];
}

export interface Query<Row> {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly ast: SelectStatement;
  readonly __row: (value: Row) => Row;
}

export interface SqlTag {
  <Row = unknown>(strings: TemplateStringsArray, ...parts: readonly unknown[]): Query<Row>;
  readonly ident: (name: string) => SqlFragment;
  readonly value: (value: unknown) => SqlFragment;
  readonly join: (parts: readonly SqlFragment[], separator?: string) => SqlFragment;
  readonly raw: (text: string) => SqlFragment;
  readonly dynamic: (text: string) => Query<unknown>;
}

export interface QueryExecutor {
  execute(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

export interface Database {
  execute<Row>(query: Query<Row>): Promise<readonly Row[]>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}

export type TransactionRunner = <T>(fn: (executor: QueryExecutor) => Promise<T>) => Promise<T>;

function text(textValue: string): TextSegment {
  return { kind: "text", text: textValue };
}

function value(valueItem: unknown): ValueSegment {
  return { kind: "value", value: valueItem };
}

function fragment(segments: readonly Segment[]): SqlFragment {
  return Object.freeze({ [fragmentBrand]: true as const, segments: Object.freeze([...segments]) });
}

function isFragment(part: unknown): part is SqlFragment {
  return typeof part === "object" && part !== null && fragmentBrand in part;
}

function render(segments: readonly Segment[]): { readonly text: string; readonly values: readonly unknown[] } {
  const values: unknown[] = [];
  let sqlText = "";
  for (const segment of segments) {
    if (segment.kind === "text") sqlText += segment.text;
    else {
      values.push(segment.value);
      sqlText += `$${values.length}`;
    }
  }
  return { text: sqlText, values: Object.freeze(values) };
}

function query<Row>(segments: readonly Segment[]): Query<Row> {
  const rendered = render(segments);
  const ast = parseSelect(rendered.text);
  return Object.freeze({
    text: rendered.text,
    values: rendered.values,
    ast,
    __row: (row: Row): Row => row,
  });
}

const tag = <Row = unknown>(strings: TemplateStringsArray, ...parts: readonly unknown[]): Query<Row> => {
  const segments: Segment[] = [];
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
    return fragment([text(`"${name.replaceAll('"', '""')}"`)]);
  },
  value(valueItem: unknown): SqlFragment {
    return fragment([value(valueItem)]);
  },
  join(parts: readonly SqlFragment[], separator = ", "): SqlFragment {
    const segments: Segment[] = [];
    parts.forEach((part, index) => {
      if (index > 0) segments.push(text(separator));
      segments.push(...part.segments);
    });
    return fragment(segments);
  },
  raw(sqlText: string): SqlFragment {
    return fragment([text(sqlText)]);
  },
  dynamic(sqlText: string): Query<unknown> {
    return query<unknown>([text(sqlText)]);
  },
}) satisfies SqlTag;

class DatabaseImplementation implements Database {
  readonly #executor: QueryExecutor;
  readonly #transactionRunner: TransactionRunner | undefined;

  constructor(executor: QueryExecutor, transactionRunner?: TransactionRunner) {
    this.#executor = executor;
    this.#transactionRunner = transactionRunner;
  }

  async execute<Row>(queryValue: Query<Row>): Promise<readonly Row[]> {
    const rows = await this.#executor.execute(queryValue.text, queryValue.values);
    return rows as readonly Row[];
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const transactionRunner = this.#transactionRunner;
    if (transactionRunner === undefined) throw new Error("This database adapter does not support transactions");
    return transactionRunner(async (executor) => fn(new DatabaseImplementation(executor, transactionRunner)));
  }
}

export function createDatabase(executor: QueryExecutor, transactionRunner?: TransactionRunner): Database {
  return new DatabaseImplementation(executor, transactionRunner);
}

export { createPostgresDatabase, createPostgresTypeParsers } from "./postgres.js";
export type * from "./postgres.js";
