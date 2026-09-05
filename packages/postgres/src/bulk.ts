import {
  compileQueryRenderSkeleton,
  defineAdapterCapability,
  type ExecutionOptions,
  executeBulkRows,
  type Query,
  QueryCancelledError,
  type QueryStream,
  type SqlRenderer,
} from "@typed-sql/core";
import { parseStatement } from "./parser/index.js";

const postgresRenderer: SqlRenderer = Object.freeze({
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
});

export interface PostgresCopyProgress {
  readonly rows: number;
  readonly bytes: number;
}

export interface PostgresCopyResult extends PostgresCopyProgress {}

export interface PostgresCopyFromOptions extends ExecutionOptions {
  /** Preferred encoded chunk size. One unusually wide row may exceed it. */
  readonly chunkBytes?: number;
  readonly onProgress?: (progress: PostgresCopyProgress) => void;
}

export interface PostgresCopyToOptions extends ExecutionOptions {}

export interface PostgresCopyTransport {
  copyFrom(statement: string, chunks: AsyncIterable<Uint8Array>, options: ExecutionOptions): Promise<void>;
  copyTo(statement: string, options: ExecutionOptions): QueryStream<Uint8Array>;
}

export interface PostgresCopyCapability {
  /**
   * Compiles one ordinary typed single-row INSERT factory into COPY FROM STDIN.
   * Every later row must preserve the first query's exact structural shape.
   */
  copyFrom<Input, Row, Params extends readonly unknown[]>(
    rowQuery: (input: Input) => Query<Row, Params>,
    rows: Iterable<Input> | AsyncIterable<Input>,
    options?: PostgresCopyFromOptions,
  ): Promise<PostgresCopyResult>;

  /** Streams raw PostgreSQL CSV bytes for a static typed SELECT query. */
  copyTo<Row>(query: Query<Row, readonly []>, options?: PostgresCopyToOptions): QueryStream<Uint8Array>;
}

export const postgresCopy = defineAdapterCapability<PostgresCopyCapability>("postgres.copy");

const encoder = new TextEncoder();
const DEFAULT_CHUNK_BYTES = 64 * 1_024;

function quoteIdentifier(value: string): string {
  return postgresRenderer.quoteIdentifier(value);
}

function postgresArrayElement(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return postgresArray(value);
  const encoded = postgresTextValue(value);
  return `"${encoded.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function postgresArray(value: readonly unknown[]): string {
  return `{${value.map(postgresArrayElement).join(",")}}`;
}

function postgresTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("PostgreSQL COPY cannot encode non-finite numbers");
    return String(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError("PostgreSQL COPY cannot encode an invalid Date");
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) return postgresArray(value);
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  throw new TypeError(`PostgreSQL COPY cannot encode ${typeof value} values`);
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  return `"${postgresTextValue(value).replaceAll('"', '""')}"`;
}

function csvRow(values: readonly unknown[]): Uint8Array {
  return encoder.encode(`${values.map(csvField).join(",")}\n`);
}

function chunkSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("PostgreSQL COPY chunkBytes must be a positive safe integer");
  }
  return resolved;
}

function copyFromStatement(text: string, parameterCount: number): string {
  const statement = parseStatement(text);
  if (
    statement.kind !== "insert" ||
    statement.with !== undefined ||
    statement.table.alias !== undefined ||
    statement.source.kind !== "values" ||
    statement.source.rows.length !== 1 ||
    statement.returning.length !== 0 ||
    statement.columns.length === 0
  ) {
    throw new TypeError(
      "PostgreSQL COPY requires a plain single-row INSERT with an explicit column list, one VALUES row, and no RETURNING clause",
    );
  }
  const values = statement.source.rows[0]!;
  if (
    values.length !== statement.columns.length ||
    values.length !== parameterCount ||
    values.some((expression, index) => expression.kind !== "parameter" || expression.index !== index + 1)
  ) {
    throw new TypeError("PostgreSQL COPY INSERT values must be one ordered parameter per target column");
  }
  const table = `${statement.table.schema === undefined ? "" : `${quoteIdentifier(statement.table.schema.name)}.`}${quoteIdentifier(statement.table.name.name)}`;
  const columns = statement.columns.map(({ name }) => quoteIdentifier(name)).join(", ");
  return `COPY ${table} (${columns}) FROM STDIN WITH (FORMAT csv)`;
}

function copyToStatement<Row>(query: Query<Row, readonly []>): string {
  const { rendered } = compileQueryRenderSkeleton(query, postgresRenderer);
  if (rendered.values.length !== 0)
    throw new TypeError("PostgreSQL COPY TO accepts only static queries without parameters");
  const text = rendered.text.trim().replace(/;\s*$/u, "");
  if (parseStatement(text).kind !== "select") {
    throw new TypeError("PostgreSQL COPY TO requires a SELECT query");
  }
  return `COPY (${text}) TO STDOUT WITH (FORMAT csv)`;
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new QueryCancelledError("signal", { cause: signal.reason });
}

export function createPostgresCopyCapability(transport: PostgresCopyTransport): PostgresCopyCapability {
  return Object.freeze({
    async copyFrom<Input, Row, Params extends readonly unknown[]>(
      rowQuery: (input: Input) => Query<Row, Params>,
      rows: Iterable<Input> | AsyncIterable<Input>,
      options: PostgresCopyFromOptions = {},
    ): Promise<PostgresCopyResult> {
      return executeBulkRows(rowQuery, rows, options, {
        renderer: postgresRenderer,
        chunkBytes: chunkSize(options.chunkBytes),
        shapeError: "PostgreSQL COPY row query changed its structural SQL shape",
        statement: copyFromStatement,
        encodeRow: csvRow,
        transfer: (statement, chunks, options) => transport.copyFrom(statement, chunks, options),
      });
    },

    copyTo<Row>(query: Query<Row, readonly []>, options: PostgresCopyToOptions = {}): QueryStream<Uint8Array> {
      cancelled(options.signal);
      return transport.copyTo(copyToStatement(query), options);
    },
  });
}
