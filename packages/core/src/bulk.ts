import { type ExecutionOptions, QueryCancelledError } from "./execution.js";
import { bindQueryRenderSkeleton, compileQueryRenderSkeleton, type Query, type SqlRenderer } from "./query.js";

export interface BulkRowProgress {
  readonly rows: number;
  readonly bytes: number;
}
export interface BulkRowOptions extends ExecutionOptions {
  readonly onProgress?: (progress: BulkRowProgress) => void;
}
/** The adapter validates chunkBytes and owns all SQL and value encoding policy. */
export interface BulkRowPolicy {
  readonly renderer: SqlRenderer;
  readonly chunkBytes: number;
  readonly shapeError: string;
  readonly statement: (text: string, parameterCount: number) => string;
  readonly encodeRow: (values: readonly unknown[]) => Uint8Array;
  readonly transfer: (statement: string, chunks: AsyncIterable<Uint8Array>, options: ExecutionOptions) => Promise<void>;
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

/** Runs a bounded, backpressured producer without depending on any database driver. */
export async function executeBulkRows<Input, Row, Params extends readonly unknown[]>(
  rowQuery: (input: Input) => Query<Row, Params>,
  rows: Iterable<Input> | AsyncIterable<Input>,
  options: BulkRowOptions,
  policy: BulkRowPolicy,
): Promise<BulkRowProgress> {
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
    compiled = compileQueryRenderSkeleton(firstQuery, policy.renderer);
    statement = policy.statement(compiled.rendered.text, compiled.rendered.values.length);
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
        if (rendered === undefined) throw new TypeError(policy.shapeError);
        const encoded = policy.encodeRow(rendered.values);
        if (pendingBytes > 0 && pendingBytes + encoded.byteLength > policy.chunkBytes) {
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
    await policy.transfer(statement, chunks, options);
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
}
