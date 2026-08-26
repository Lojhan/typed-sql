import type { QueryStream } from "@typed-sql/core";
import {
  compileMySqlRowDecoders,
  decodeMySqlRow,
  type MySqlFieldLike,
  type MySqlRuntimeTypePolicy,
} from "./decoding.js";

/** A protocol-level MySQL row stream supplied by an execution adapter. */
export interface MySqlProtocolStream extends AsyncIterableIterator<Record<string, unknown>> {
  /** Resolves once result metadata is available, before the first row is decoded. */
  readonly fields: Promise<readonly MySqlFieldLike[]>;
  /** Whether the leased connection may safely return to its pool after close. */
  readonly connectionReusable: boolean;
  /** Stops row delivery and resolves only after the underlying protocol operation terminates. */
  close(): Promise<void>;
}

export interface MySqlStreamingConnection {
  stream?(sql: string, values: readonly unknown[], options: { readonly batchSize: number }): MySqlProtocolStream;
  release(): void;
}

interface OpenMySqlStream {
  readonly connection: MySqlStreamingConnection;
  readonly release: boolean;
}

interface ActiveMySqlStream extends OpenMySqlStream {
  readonly source: MySqlProtocolStream;
  readonly decoders: ReturnType<typeof compileMySqlRowDecoders>;
  readonly hasRows: boolean;
}

export function validateMySqlStreamBatchSize(value: number | undefined): number {
  const batchSize = value ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new RangeError("MySQL stream batchSize must be a positive safe integer");
  return batchSize;
}

export function createMySqlQueryStream<Row>(options: {
  readonly openConnection: () => Promise<OpenMySqlStream>;
  readonly text: string;
  readonly values: readonly unknown[];
  readonly batchSize: number;
  readonly typePolicy: MySqlRuntimeTypePolicy;
  readonly decimal?: (value: string) => unknown;
  readonly onClose: () => void;
}): QueryStream<Row> {
  return new MySqlQueryStream(options);
}

class MySqlQueryStream<Row> implements QueryStream<Row> {
  readonly #openConnection: () => Promise<OpenMySqlStream>;
  readonly #text: string;
  readonly #values: readonly unknown[];
  readonly #batchSize: number;
  readonly #typePolicy: MySqlRuntimeTypePolicy;
  readonly #decimal: ((value: string) => unknown) | undefined;
  readonly #onClose: () => void;
  #active: ActiveMySqlStream | undefined;
  #opening: Promise<ActiveMySqlStream> | undefined;
  #finishing: Promise<void> | undefined;
  #closed = false;
  #notifiedClosed = false;
  #queue = Promise.resolve();

  constructor(options: {
    readonly openConnection: () => Promise<OpenMySqlStream>;
    readonly text: string;
    readonly values: readonly unknown[];
    readonly batchSize: number;
    readonly typePolicy: MySqlRuntimeTypePolicy;
    readonly decimal?: (value: string) => unknown;
    readonly onClose: () => void;
  }) {
    this.#openConnection = options.openConnection;
    this.#text = options.text;
    this.#values = options.values;
    this.#batchSize = options.batchSize;
    this.#typePolicy = options.typePolicy;
    this.#decimal = options.decimal;
    this.#onClose = options.onClose;
  }

  [Symbol.asyncIterator](): QueryStream<Row> {
    return this;
  }

  next(): Promise<IteratorResult<Row>> {
    return this.#enqueue(() => this.#next());
  }

  return(): Promise<IteratorResult<Row>> {
    return this.#enqueue(async () => {
      await this.#finish();
      return { done: true, value: undefined };
    });
  }

  async throw(error?: unknown): Promise<IteratorResult<Row>> {
    await this.close();
    throw error;
  }

  close(): Promise<void> {
    return this.#enqueue(() => this.#finish());
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #enqueue<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #next(): Promise<IteratorResult<Row>> {
    if (this.#closed) return { done: true, value: undefined };
    let active: ActiveMySqlStream;
    try {
      active = await this.#start();
      if (!active.hasRows) {
        await this.#finish();
        return { done: true, value: undefined };
      }
      const result = await active.source.next();
      if (result.done) {
        await this.#finish();
        return { done: true, value: undefined };
      }
      const decoded = decodeMySqlRow(result.value, active.decoders) as Row;
      return { done: false, value: decoded };
    } catch (error) {
      try {
        await this.#finish();
      } catch {
        /* Preserve the query or decoding failure. */
      }
      throw error;
    }
  }

  #start(): Promise<ActiveMySqlStream> {
    if (this.#opening !== undefined) return this.#opening;
    this.#opening = this.#open();
    return this.#opening;
  }

  async #open(): Promise<ActiveMySqlStream> {
    const opened = await this.#openConnection();
    const stream = opened.connection.stream;
    if (stream === undefined) {
      if (opened.release) opened.connection.release();
      this.#closed = true;
      this.#notifyClosed();
      throw new Error("This MySQL execution adapter does not support protocol row streaming");
    }
    let source: MySqlProtocolStream | undefined;
    try {
      source = stream.call(opened.connection, this.#text, this.#values, { batchSize: this.#batchSize });
      const fields = await source.fields;
      const decoders = compileMySqlRowDecoders(fields, this.#typePolicy, this.#decimal);
      const active = { source, decoders, hasRows: fields.length > 0, ...opened };
      this.#active = active;
      return active;
    } catch (error) {
      if (source !== undefined) {
        this.#active = { source, decoders: [], hasRows: false, ...opened };
        try {
          await this.#finish();
        } catch {
          /* Preserve the stream startup failure. */
        }
      } else {
        if (opened.release) {
          try {
            opened.connection.release();
          } catch {
            /* Preserve the stream startup failure. */
          }
        }
        this.#closed = true;
        this.#notifyClosed();
      }
      throw error;
    }
  }

  #finish(): Promise<void> {
    if (this.#finishing !== undefined) return this.#finishing;
    this.#closed = true;
    this.#finishing = this.#cleanup();
    return this.#finishing;
  }

  async #cleanup(): Promise<void> {
    let failure: unknown;
    try {
      if (this.#active !== undefined) await this.#active.source.close();
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (this.#active?.release && this.#active.source.connectionReusable) this.#active.connection.release();
      } catch (error) {
        failure ??= error;
      } finally {
        this.#notifyClosed();
      }
    }
    if (failure !== undefined) throw failure;
  }

  #notifyClosed(): void {
    if (this.#notifiedClosed) return;
    this.#notifiedClosed = true;
    this.#onClose();
  }
}
