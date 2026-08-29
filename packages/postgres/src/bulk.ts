import { parseStatement } from "@typed-sql/ast";
import {
  bindQueryRenderSkeleton,
  compileQueryRenderSkeleton,
  defineAdapterCapability,
  type ExecutionOptions,
  type Query,
  QueryCancelledError,
  type QueryStream,
  type SqlRenderer,
} from "@typed-sql/core";

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

function asyncIterator<Value>(values: Iterable<Value> | AsyncIterable<Value>): AsyncIterator<Value> {
  if (Symbol.asyncIterator in Object(values)) return (values as AsyncIterable<Value>)[Symbol.asyncIterator]();
  const iterator = (values as Iterable<Value>)[Symbol.iterator]();
  return {
    next: async () => iterator.next(),
    ...(iterator.return === undefined ? {} : { return: async () => iterator.return!() }),
  };
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function createPostgresCopyCapability(transport: PostgresCopyTransport): PostgresCopyCapability {
  return Object.freeze({
    async copyFrom<Input, Row, Params extends readonly unknown[]>(
      rowQuery: (input: Input) => Query<Row, Params>,
      rows: Iterable<Input> | AsyncIterable<Input>,
      options: PostgresCopyFromOptions = {},
    ): Promise<PostgresCopyResult> {
      const preferredChunkBytes = chunkSize(options.chunkBytes);
      cancelled(options.signal);
      const iterator = asyncIterator(rows);
      let iteratorClosed = false;
      const closeIterator = async (): Promise<void> => {
        if (iteratorClosed || iterator.return === undefined) return;
        iteratorClosed = true;
        await iterator.return();
      };
      let first: IteratorResult<Input>;
      try {
        first = await iterator.next();
      } catch (error) {
        try {
          await closeIterator();
        } catch {
          /* Preserve the producer failure. */
        }
        throw error;
      }
      if (first.done === true) return Object.freeze({ rows: 0, bytes: 0 });

      let firstQuery: Query<Row, Params>;
      let compiled: ReturnType<typeof compileQueryRenderSkeleton<Row, Params>>;
      let statement: string;
      try {
        firstQuery = rowQuery(first.value);
        compiled = compileQueryRenderSkeleton(firstQuery, postgresRenderer);
        statement = copyFromStatement(compiled.rendered.text, compiled.rendered.values.length);
      } catch (error) {
        try {
          await closeIterator();
        } catch {
          /* Preserve the query compilation failure. */
        }
        throw error;
      }
      let rowCount = 0;
      let byteCount = 0;
      let inputComplete = false;

      const chunks = (async function* (): AsyncGenerator<Uint8Array> {
        let pending: Uint8Array[] = [];
        let pendingBytes = 0;
        let current: IteratorResult<Input> = first;
        try {
          while (current.done !== true) {
            cancelled(options.signal);
            const query = rowCount === 0 ? firstQuery : rowQuery(current.value);
            const rendered = rowCount === 0 ? compiled.rendered : bindQueryRenderSkeleton(query, compiled.skeleton);
            if (rendered === undefined) {
              throw new TypeError("PostgreSQL COPY row query changed its structural SQL shape");
            }
            const encoded = csvRow(rendered.values);
            if (pendingBytes > 0 && pendingBytes + encoded.byteLength > preferredChunkBytes) {
              const chunk = concatenate(pending, pendingBytes);
              byteCount += chunk.byteLength;
              options.onProgress?.(Object.freeze({ rows: rowCount, bytes: byteCount }));
              yield chunk;
              pending = [];
              pendingBytes = 0;
            }
            pending.push(encoded);
            pendingBytes += encoded.byteLength;
            rowCount += 1;
            current = await iterator.next();
          }
          inputComplete = true;
          if (pendingBytes > 0) {
            const chunk = concatenate(pending, pendingBytes);
            byteCount += chunk.byteLength;
            options.onProgress?.(Object.freeze({ rows: rowCount, bytes: byteCount }));
            yield chunk;
          }
        } finally {
          if (current.done !== true) await closeIterator();
        }
      })();

      try {
        await transport.copyFrom(statement, chunks, options);
      } catch (error) {
        if (!inputComplete) {
          try {
            await closeIterator();
          } catch {
            /* Preserve the transport, producer, or database failure. */
          }
        }
        throw error;
      }
      if (!inputComplete) await closeIterator();
      return Object.freeze({ rows: rowCount, bytes: byteCount });
    },

    copyTo<Row>(query: Query<Row, readonly []>, options: PostgresCopyToOptions = {}): QueryStream<Uint8Array> {
      cancelled(options.signal);
      return transport.copyTo(copyToStatement(query), options);
    },
  });
}
