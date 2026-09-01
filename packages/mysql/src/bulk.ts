import {
  bindQueryRenderSkeleton,
  compileQueryRenderSkeleton,
  defineAdapterCapability,
  type ExecutionOptions,
  type Query,
  QueryCancelledError,
  type SqlRenderer,
} from "@typed-sql/core";
import { parseStatement } from "./parser/index.js";

const mysqlRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (name: string) => `\`${name.replaceAll("`", "``")}\``,
});

export interface MySqlBulkProgress {
  readonly rows: number;
  readonly bytes: number;
}

export interface MySqlBulkResult extends MySqlBulkProgress {}

export interface MySqlLoadDataOptions extends ExecutionOptions {
  /** Preferred encoded chunk size. One unusually wide row may exceed it. */
  readonly chunkBytes?: number;
  readonly onProgress?: (progress: MySqlBulkProgress) => void;
}

export interface MySqlBulkTransport {
  loadData(statement: string, chunks: AsyncIterable<Uint8Array>, options: ExecutionOptions): Promise<void>;
}

export interface MySqlBulkCapability {
  /** Compiles one typed INSERT factory into a client-streamed LOAD DATA LOCAL INFILE operation. */
  loadData<Input, Row, Params extends readonly unknown[]>(
    rowQuery: (input: Input) => Query<Row, Params>,
    rows: Iterable<Input> | AsyncIterable<Input>,
    options?: MySqlLoadDataOptions,
  ): Promise<MySqlBulkResult>;
}

export const mysqlBulk = defineAdapterCapability<MySqlBulkCapability>("mysql.load-data");

const encoder = new TextEncoder();
const DEFAULT_CHUNK_BYTES = 64 * 1_024;

function mysqlTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("MySQL LOAD DATA cannot encode non-finite numbers");
    return String(value);
  }
  if (value instanceof Date) {
    throw new TypeError(
      "MySQL LOAD DATA text mode does not accept Date values because mysql2 timezone encoding is connection-specific; use ordinary execution",
    );
  }
  if (value instanceof Uint8Array) {
    throw new TypeError("MySQL LOAD DATA text mode does not accept binary values; use ordinary execution");
  }
  if (typeof value === "object" && value !== null) {
    throw new TypeError(
      "MySQL LOAD DATA text mode does not accept structured values because mysql2 parameter encoding is type-specific; use ordinary execution",
    );
  }
  throw new TypeError(`MySQL LOAD DATA cannot encode ${typeof value} values`);
}

function escapedField(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  return mysqlTextValue(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\0", "\\0")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function encodedRow(values: readonly unknown[]): Uint8Array {
  return encoder.encode(`${values.map(escapedField).join("\t")}\n`);
}

function chunkSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("MySQL LOAD DATA chunkBytes must be a positive safe integer");
  }
  return resolved;
}

function loadDataStatement(text: string, parameterCount: number): string {
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
      "MySQL LOAD DATA requires a plain single-row INSERT with an explicit column list and one VALUES row",
    );
  }
  const values = statement.source.rows[0]!;
  if (
    values.length !== statement.columns.length ||
    values.length !== parameterCount ||
    values.some((expression, index) => expression.kind !== "parameter" || expression.index !== index + 1)
  ) {
    throw new TypeError("MySQL LOAD DATA INSERT values must be one ordered parameter per target column");
  }
  const quote = mysqlRenderer.quoteIdentifier;
  const table = `${statement.table.schema === undefined ? "" : `${quote(statement.table.schema.name)}.`}${quote(statement.table.name.name)}`;
  const columns = statement.columns.map(({ name }) => quote(name)).join(", ");
  return `LOAD DATA LOCAL INFILE 'typed-sql-stream' INTO TABLE ${table} CHARACTER SET utf8mb4 FIELDS TERMINATED BY '\\t' ESCAPED BY '\\\\' LINES TERMINATED BY '\\n' (${columns})`;
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

export function createMySqlBulkCapability(transport: MySqlBulkTransport): MySqlBulkCapability {
  return Object.freeze({
    async loadData<Input, Row, Params extends readonly unknown[]>(
      rowQuery: (input: Input) => Query<Row, Params>,
      rows: Iterable<Input> | AsyncIterable<Input>,
      options: MySqlLoadDataOptions = {},
    ): Promise<MySqlBulkResult> {
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
        compiled = compileQueryRenderSkeleton(firstQuery, mysqlRenderer);
        statement = loadDataStatement(compiled.rendered.text, compiled.rendered.values.length);
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
            if (rendered === undefined)
              throw new TypeError("MySQL LOAD DATA row query changed its structural SQL shape");
            const encoded = encodedRow(rendered.values);
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
        await transport.loadData(statement, chunks, options);
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
  });
}
