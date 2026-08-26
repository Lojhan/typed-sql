import type { QueryStream } from "@typed-sql/core";

export interface PostgresCursorLike {
  read(rowCount: number): Promise<readonly Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface PostgresCursorLease {
  readonly cursor: PostgresCursorLike;
  release?(cleanupError?: unknown): void | Promise<void>;
}

export interface PostgresQueryStreamOptions {
  readonly batchSize: number;
  readonly start: () => Promise<PostgresCursorLease>;
  readonly onError?: (error: unknown) => void;
  readonly onStart?: () => void;
  readonly onClose?: () => void;
}

function done(): IteratorReturnResult<undefined> {
  return { done: true, value: undefined };
}

/**
 * A demand-driven row iterator over a cursor lease.
 *
 * Operations are serialized because native PostgreSQL cursors cannot safely process overlapping
 * reads. Cleanup always attempts both cursor close and lease release, while keeping the first
 * operation or cleanup error as the observable failure.
 */
export class PostgresQueryStream<Row> implements QueryStream<Row> {
  readonly #batchSize: number;
  readonly #start: () => Promise<PostgresCursorLease>;
  readonly #onClose: (() => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onStart: (() => void) | undefined;
  #buffer: readonly Row[] = [];
  #bufferIndex = 0;
  #lease: PostgresCursorLease | undefined;
  #operation: Promise<void> = Promise.resolve();
  #terminal = false;

  constructor(options: PostgresQueryStreamOptions) {
    this.#batchSize = options.batchSize;
    this.#start = options.start;
    this.#onStart = options.onStart;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<Row, undefined>> {
    return this.#enqueue(async () => {
      if (this.#terminal) return done();
      if (this.#bufferIndex < this.#buffer.length) {
        return { done: false, value: this.#buffer[this.#bufferIndex++]! };
      }

      try {
        if (this.#lease === undefined) this.#onStart?.();
        this.#lease ??= await this.#start();
        const rows = await this.#lease.cursor.read(this.#batchSize);
        if (rows.length === 0) {
          await this.#terminate();
          return done();
        }
        this.#buffer = rows as readonly Row[];
        this.#bufferIndex = 1;
        return { done: false, value: this.#buffer[0]! };
      } catch (error) {
        await this.#terminate(error);
        throw error;
      }
    });
  }

  return(): Promise<IteratorResult<Row, undefined>> {
    return this.#enqueue(async () => {
      await this.#terminate();
      return done();
    });
  }

  close(): Promise<void> {
    return this.#enqueue(() => this.#terminate());
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #enqueue<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#operation.then(operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #terminate(primaryError?: unknown): Promise<void> {
    if (this.#terminal) {
      if (primaryError !== undefined) throw primaryError;
      return;
    }

    this.#terminal = true;
    const hadLease = this.#lease !== undefined;
    this.#buffer = [];
    this.#bufferIndex = 0;
    let cleanupError: unknown;
    try {
      if (this.#lease !== undefined) await this.#lease.cursor.close();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await this.#lease?.release?.(primaryError !== undefined ? primaryError : cleanupError);
    } catch (error) {
      cleanupError ??= error;
    } finally {
      this.#onClose?.();
    }

    const terminalError = primaryError ?? cleanupError;
    if (hadLease && terminalError !== undefined) {
      try {
        this.#onError?.(terminalError);
      } catch {
        /* Lifecycle observers cannot replace the stream's primary error. */
      }
    }
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
  }
}

export function validatePostgresStreamBatchSize(batchSize: number | undefined): number {
  const resolved = batchSize ?? 100;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("PostgreSQL stream batchSize must be a positive safe integer");
  }
  return resolved;
}
