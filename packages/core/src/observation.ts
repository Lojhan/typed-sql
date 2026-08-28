import type { QueryCancellationReason, QueryCardinalityExpectation, QueryStream } from "./execution.js";

export type QueryObservationCardinality = QueryCardinalityExpectation | "many";
export type DatabaseObservationStatus = "success" | "error" | "cancelled";

interface DatabaseOperationCommon {
  readonly dialect: string;
  readonly grammarVersion: string;
  readonly transactionDepth: number;
}

export interface QueryOperationStart extends DatabaseOperationCommon {
  readonly kind: "query";
  readonly fingerprint: string;
  readonly cardinality: QueryObservationCardinality;
  readonly prepared: boolean;
}

export interface BatchOperationStart extends DatabaseOperationCommon {
  readonly kind: "batch" | "pipeline";
  readonly fingerprints: readonly string[];
  readonly size: number;
}

export interface StreamOperationStart extends DatabaseOperationCommon {
  readonly kind: "stream";
  readonly fingerprint: string;
  readonly prepared: boolean;
}

export interface TransactionOperationStart extends DatabaseOperationCommon {
  readonly kind: "transaction";
}

export type DatabaseOperationStart =
  | QueryOperationStart
  | BatchOperationStart
  | StreamOperationStart
  | TransactionOperationStart;

export interface DatabaseOperationCompletion {
  readonly status: DatabaseObservationStatus;
  readonly rowCount?: number;
  readonly errorType?: string;
  readonly cancellationReason?: QueryCancellationReason;
}

export interface DatabaseOperationEnd extends DatabaseOperationCompletion {
  readonly durationMilliseconds: number;
  /** Present only when the observer explicitly enables error-cause capture. */
  readonly cause?: unknown;
}

export interface DatabaseObservation {
  /** Runs dispatch in observer-owned context, such as an OpenTelemetry span context. */
  run?<Value>(operation: () => Value): Value;
  end(completion: DatabaseOperationEnd): void;
}

export interface DatabaseObserver {
  /** Error objects may include sensitive driver text and are excluded by default. */
  readonly captureErrorCause?: boolean;
  start(operation: DatabaseOperationStart): DatabaseObservation | undefined;
}

export interface ActiveDatabaseObservation {
  run<Value>(operation: () => Value): Value;
  end(completion: DatabaseOperationCompletion, cause?: unknown): void;
}

function classifiedErrorType(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && typeof error.code === "string") return error.code;
    if (error instanceof Error && error.name.length > 0) return error.name;
  }
  return typeof error;
}

/** Starts one redacted operation lifecycle. Observer start/end failures never replace database results. */
export function startDatabaseObservation(
  observer: DatabaseObserver | undefined,
  operation: DatabaseOperationStart,
): ActiveDatabaseObservation | undefined {
  if (observer === undefined) return undefined;
  const started = performance.now();
  let observation: DatabaseObservation | undefined;
  try {
    observation = observer.start(Object.freeze(operation));
  } catch {
    return undefined;
  }
  if (observation === undefined) return undefined;
  let ended = false;
  return {
    run<Value>(callback: () => Value): Value {
      return observation.run === undefined ? callback() : observation.run(callback);
    },
    end(completion: DatabaseOperationCompletion, cause?: unknown): void {
      if (ended) return;
      ended = true;
      const event = Object.freeze({
        ...completion,
        durationMilliseconds: Math.max(0, performance.now() - started),
        ...(observer.captureErrorCause === true && cause !== undefined ? { cause } : {}),
      });
      try {
        observation.end(event);
      } catch {
        /* Observation must not replace a database result or failure. */
      }
    },
  };
}

export function databaseErrorCompletion(error: unknown): DatabaseOperationCompletion {
  const cancellationReason =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "TSQL_CANCELLED" &&
    "reason" in error &&
    (error.reason === "signal" || error.reason === "deadline")
      ? error.reason
      : undefined;
  return Object.freeze({
    status: cancellationReason === undefined ? "error" : "cancelled",
    errorType: classifiedErrorType(error),
    ...(cancellationReason === undefined ? {} : { cancellationReason }),
  });
}

/** Adds a lazy, exactly-once observation lifecycle to an adapter-owned query stream. */
export function observeQueryStream<Row>(
  stream: QueryStream<Row>,
  observer: DatabaseObserver | undefined,
  operation: StreamOperationStart,
): QueryStream<Row> {
  if (observer === undefined) return stream;
  let observation: ActiveDatabaseObservation | undefined;
  let startAttempted = false;
  let rowCount = 0;
  let ended = false;
  const start = (): ActiveDatabaseObservation | undefined => {
    if (!startAttempted) {
      startAttempted = true;
      observation = startDatabaseObservation(observer, operation);
    }
    return observation;
  };
  const end = (completion: DatabaseOperationCompletion, cause?: unknown): void => {
    if (ended) return;
    ended = true;
    observation?.end({ ...completion, rowCount }, cause);
  };
  const observed: QueryStream<Row> = {
    async next(): Promise<IteratorResult<Row>> {
      const active = start();
      try {
        const result = await (active === undefined ? stream.next() : active.run(() => stream.next()));
        if (result.done) end({ status: "success" });
        else rowCount += 1;
        return result;
      } catch (error) {
        end(databaseErrorCompletion(error), error);
        throw error;
      }
    },
    async return(value?: unknown): Promise<IteratorResult<Row>> {
      try {
        const callback = (): Promise<IteratorResult<Row>> =>
          stream.return === undefined
            ? stream.close().then(() => ({ done: true, value: value as Row }))
            : stream.return(value);
        const result = await (observation === undefined ? callback() : observation.run(callback));
        end({ status: "success" });
        return result;
      } catch (error) {
        end(databaseErrorCompletion(error), error);
        throw error;
      }
    },
    async throw(error?: unknown): Promise<IteratorResult<Row>> {
      try {
        const callback = (): Promise<IteratorResult<Row>> =>
          stream.throw === undefined ? Promise.reject(error) : stream.throw(error);
        const result = await (observation === undefined ? callback() : observation.run(callback));
        if (result.done) {
          if (error === undefined) end({ status: "success" });
          else end(databaseErrorCompletion(error), error);
        }
        return result;
      } catch (failure) {
        end(databaseErrorCompletion(failure), failure);
        throw failure;
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async close(): Promise<void> {
      try {
        await (observation === undefined ? stream.close() : observation.run(() => stream.close()));
        end({ status: "success" });
      } catch (error) {
        end(databaseErrorCompletion(error), error);
        throw error;
      }
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await this.close();
    },
  };
  return observed;
}
