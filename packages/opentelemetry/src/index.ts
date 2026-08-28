import { type Attributes, context, type Span, SpanKind, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import type {
  DatabaseObservation,
  DatabaseObserver,
  DatabaseOperationEnd,
  DatabaseOperationStart,
} from "@typed-sql/core";

export interface OpenTelemetryObserverOptions {
  readonly tracer?: Tracer;
  readonly instrumentationName?: string;
  readonly instrumentationVersion?: string;
  /** Opt-in because database row counts are an opt-in OpenTelemetry attribute. */
  readonly recordReturnedRows?: boolean;
  /** Opt-in because driver errors can contain query text or values. */
  readonly recordExceptions?: boolean;
  /** Opt-in because a fingerprint list can be high-cardinality for dynamic batches. */
  readonly recordBatchFingerprints?: boolean;
}

function databaseSystem(dialect: string): string {
  if (dialect === "postgres") return "postgresql";
  return dialect;
}

function spanName(operation: DatabaseOperationStart): string {
  const system = databaseSystem(operation.dialect);
  if (operation.kind === "batch") return `BATCH ${system}`;
  if (operation.kind === "pipeline") return `PIPELINE ${system}`;
  if (operation.kind === "transaction") return `TRANSACTION ${system}`;
  return system;
}

function startAttributes(operation: DatabaseOperationStart, options: OpenTelemetryObserverOptions): Attributes {
  const attributes: Attributes = {
    "db.system.name": databaseSystem(operation.dialect),
    "typed_sql.grammar.version": operation.grammarVersion,
    "typed_sql.operation.kind": operation.kind,
    "typed_sql.transaction.depth": operation.transactionDepth,
  };
  if (operation.kind === "query") {
    attributes["typed_sql.query.fingerprint"] = operation.fingerprint;
    attributes["typed_sql.query.cardinality"] = operation.cardinality;
    attributes["typed_sql.query.prepared"] = operation.prepared;
  } else if (operation.kind === "stream") {
    attributes["typed_sql.query.fingerprint"] = operation.fingerprint;
    attributes["typed_sql.query.prepared"] = operation.prepared;
  } else if (operation.kind === "batch" || operation.kind === "pipeline") {
    attributes["db.operation.name"] = operation.kind === "batch" ? "BATCH" : "PIPELINE";
    attributes["db.operation.batch.size"] = operation.size;
    if (options.recordBatchFingerprints === true) {
      attributes["typed_sql.query.fingerprints"] = [...operation.fingerprints];
    }
  } else attributes["db.operation.name"] = "TRANSACTION";
  return attributes;
}

function endSpan(span: Span, completion: DatabaseOperationEnd, options: OpenTelemetryObserverOptions): void {
  span.setAttribute("typed_sql.duration_ms", completion.durationMilliseconds);
  if (options.recordReturnedRows === true && completion.rowCount !== undefined) {
    span.setAttribute("db.response.returned_rows", completion.rowCount);
  }
  if (completion.status !== "success") {
    const errorType =
      completion.cancellationReason === "deadline"
        ? "timeout"
        : completion.cancellationReason === "signal"
          ? "cancelled"
          : (completion.errorType ?? "unknown");
    span.setAttribute("error.type", errorType);
    if (completion.cancellationReason !== undefined) {
      span.setAttribute("typed_sql.cancellation.reason", completion.cancellationReason);
    }
    if (options.recordExceptions === true && completion.cause instanceof Error) span.recordException(completion.cause);
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

export function createOpenTelemetryObserver(options: OpenTelemetryObserverOptions = {}): DatabaseObserver {
  const tracer =
    options.tracer ??
    trace.getTracer(options.instrumentationName ?? "@typed-sql/opentelemetry", options.instrumentationVersion);
  return Object.freeze({
    captureErrorCause: options.recordExceptions === true,
    start(operation: DatabaseOperationStart): DatabaseObservation {
      const span = tracer.startSpan(spanName(operation), {
        kind: SpanKind.CLIENT,
        attributes: startAttributes(operation, options),
      });
      const active = trace.setSpan(context.active(), span);
      return {
        run<Value>(callback: () => Value): Value {
          return context.with(active, callback);
        },
        end(completion: DatabaseOperationEnd): void {
          endSpan(span, completion, options);
        },
      };
    },
  });
}
