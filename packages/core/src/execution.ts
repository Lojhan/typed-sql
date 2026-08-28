import type { Query } from "./query.js";

export type QueryCardinalityExpectation = "one" | "maybeOne";
export type QueryCancellationReason = "signal" | "deadline";
export type ExecutionCapability = "cancellation" | "deadlines";

export interface ExecutionOptions {
  readonly signal?: AbortSignal;
  /** Absolute Unix time in milliseconds, or a Date representing that instant. */
  readonly deadline?: number | Date;
}

export interface ExecutionCapabilities {
  readonly cancellation: boolean;
  readonly deadlines: boolean;
}

export class QueryCardinalityError extends Error {
  readonly code = "TSQL_CARDINALITY";
  readonly expected: QueryCardinalityExpectation;
  readonly actual: number;

  constructor(expected: QueryCardinalityExpectation, actual: number) {
    super(
      expected === "one"
        ? `Expected exactly one row, received ${actual}`
        : `Expected at most one row, received ${actual}`,
    );
    this.name = "QueryCardinalityError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class QueryCancelledError extends Error {
  readonly code = "TSQL_CANCELLED";
  readonly reason: QueryCancellationReason;

  constructor(reason: QueryCancellationReason, options: ErrorOptions = {}) {
    super(reason === "deadline" ? "Query deadline expired" : "Query execution was cancelled", options);
    this.name = "QueryCancelledError";
    this.reason = reason;
  }
}

export class UnsupportedExecutionCapabilityError extends Error {
  readonly code = "TSQL_UNSUPPORTED_EXECUTION_CAPABILITY";
  readonly capability: ExecutionCapability;

  constructor(capability: ExecutionCapability) {
    super(`This database adapter does not support ${capability}`);
    this.name = "UnsupportedExecutionCapabilityError";
    this.capability = capability;
  }
}

export function executionDeadline(options: ExecutionOptions): number | undefined {
  if (options.deadline === undefined) return undefined;
  const deadline = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
  if (!Number.isFinite(deadline)) throw new RangeError("Execution deadline must be a finite Unix time in milliseconds");
  return deadline;
}

export function assertExecutionCapabilities(capabilities: ExecutionCapabilities, options: ExecutionOptions): void {
  executionDeadline(options);
  if (options.signal !== undefined && !capabilities.cancellation) {
    throw new UnsupportedExecutionCapabilityError("cancellation");
  }
  if (options.deadline !== undefined && !capabilities.deadlines) {
    throw new UnsupportedExecutionCapabilityError("deadlines");
  }
}

const maximumTimerDelay = 2_147_483_647;

/** Runs one dispatched operation and invokes adapter cleanup exactly once when its controls fire. */
export async function runControlledExecution<Value>(
  options: ExecutionOptions,
  operation: () => Promise<Value>,
  cancel: (error: QueryCancelledError) => void,
): Promise<Value> {
  const deadline = executionDeadline(options);
  if (options.signal?.aborted) throw new QueryCancelledError("signal", { cause: options.signal.reason });
  if (deadline !== undefined && deadline <= Date.now()) throw new QueryCancelledError("deadline");

  let cancellationError: QueryCancelledError | undefined;
  let rejectCancellation!: (error: QueryCancelledError) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  // A deadline may expire before the operation is dispatched. Keep that rejected
  // branch observed even when the function exits before constructing Promise.race.
  void cancellation.catch(() => undefined);
  const requestCancellation = (reason: QueryCancellationReason): void => {
    if (cancellationError !== undefined) return;
    cancellationError = new QueryCancelledError(reason, {
      ...(reason === "signal" ? { cause: options.signal?.reason } : {}),
    });
    try {
      cancel(cancellationError);
    } catch {
      // Cancellation is authoritative. Adapter cleanup failures must not escape
      // an AbortSignal listener or replace the stable cancellation error.
    } finally {
      rejectCancellation(cancellationError);
    }
  };
  const onAbort = (): void => requestCancellation("signal");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (): void => {
    if (deadline === undefined) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) requestCancellation("deadline");
    else
      deadlineTimer = setTimeout(
        remaining > maximumTimerDelay ? armDeadline : () => requestCancellation("deadline"),
        Math.min(remaining, maximumTimerDelay),
      );
  };
  armDeadline();

  try {
    if (cancellationError !== undefined) throw cancellationError;
    const running = operation();
    try {
      const value = await Promise.race([running, cancellation]);
      if (cancellationError !== undefined) throw cancellationError;
      return value;
    } catch (error) {
      if (cancellationError === undefined) throw error;
      await running.catch(() => undefined);
      throw cancellationError;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

/** The buffered rows produced by executing one typed query. */
export type QueryResult<Value> = Value extends Query<infer Row, infer _Params> ? readonly Row[] : never;

/**
 * Maps an ordered query tuple or array to its ordered buffered results.
 *
 * A tuple remains a tuple, while a homogeneous query array remains an array.
 */
export type QueryResults<Queries extends readonly unknown[]> = {
  readonly [Index in keyof Queries]: QueryResult<Queries[Index]>;
};

/** Validates an ordered tuple or array while preserving every query's exact type. */
export type QueryBatch<Queries extends readonly unknown[]> = Queries & {
  readonly [Index in keyof Queries]: Queries[Index] extends Query<infer Row, infer Params> ? Query<Row, Params> : never;
};

/** Common, grammar-neutral stream configuration. */
export interface StreamOptions {
  /**
   * Preferred number of rows fetched or buffered at a time.
   *
   * Adapters must reject values that are not positive safe integers. This is a row count, not a
   * byte limit or a guarantee of server-side cursor paging.
   */
  readonly batchSize?: number;
}

/** A lazy, explicitly closeable stream of typed query rows. */
export interface QueryStream<Row> extends AsyncIterableIterator<Row>, AsyncDisposable {
  close(): Promise<void>;
}
