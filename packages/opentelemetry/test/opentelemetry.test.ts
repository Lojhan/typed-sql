import {
  type Attributes,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { describe, it, strict } from "poku";
import { startDatabaseObservation } from "../../core/src/index.js";
import { createOpenTelemetryObserver } from "../src/index.js";

class FakeSpan {
  readonly attributes: Record<string, unknown> = {};
  readonly exceptions: unknown[] = [];
  status: unknown;
  endCount = 0;

  setAttribute(name: string, value: unknown): this {
    this.attributes[name] = value;
    return this;
  }

  recordException(error: unknown): void {
    this.exceptions.push(error);
  }

  setStatus(status: unknown): this {
    this.status = status;
    return this;
  }

  end(): void {
    this.endCount += 1;
  }
}

class FakeTracer {
  readonly starts: { readonly name: string; readonly options?: SpanOptions; readonly span: FakeSpan }[] = [];

  startSpan(name: string, options?: SpanOptions): Span {
    const span = new FakeSpan();
    Object.assign(span.attributes, options?.attributes as Attributes | undefined);
    this.starts.push({ name, ...(options === undefined ? {} : { options }), span });
    return span as unknown as Span;
  }
}

await describe("OpenTelemetry database observer", async () => {
  await it("emits stable database attributes without SQL, values, or batch fingerprints by default", () => {
    const tracer = new FakeTracer();
    const observer = createOpenTelemetryObserver({ tracer: tracer as unknown as Tracer });
    const observation = startDatabaseObservation(observer, {
      kind: "query",
      dialect: "postgres",
      grammarVersion: "1.0.0",
      transactionDepth: 0,
      fingerprint: "sha256:account",
      cardinality: "one",
      prepared: true,
    })!;
    strict.strictEqual(
      observation.run(() => "active"),
      "active",
    );
    observation.end({ status: "success", rowCount: 1 });

    const started = tracer.starts[0]!;
    strict.strictEqual(started.name, "postgresql");
    strict.strictEqual(started.options?.kind, SpanKind.CLIENT);
    strict.strictEqual(started.span.attributes["db.system.name"], "postgresql");
    strict.strictEqual(started.span.attributes["typed_sql.query.fingerprint"], "sha256:account");
    strict.strictEqual(started.span.attributes["typed_sql.query.cardinality"], "one");
    strict.ok(!("db.query.text" in started.span.attributes));
    strict.ok(!Object.keys(started.span.attributes).some((name) => name.includes("parameter")));
    strict.ok(!("db.response.returned_rows" in started.span.attributes));
    strict.strictEqual(started.span.endCount, 1);
  });

  await it("records sanitized cancellation and opt-in exception or row details", () => {
    const tracer = new FakeTracer();
    const observer = createOpenTelemetryObserver({
      tracer: tracer as unknown as Tracer,
      recordExceptions: true,
      recordReturnedRows: true,
    });
    const failure = new Error("driver may include sensitive SQL");
    const observation = startDatabaseObservation(observer, {
      kind: "stream",
      dialect: "mysql",
      grammarVersion: "1.0.0",
      transactionDepth: 1,
      fingerprint: "sha256:stream",
      prepared: false,
    })!;
    observation.end(
      { status: "cancelled", errorType: "TSQL_CANCELLED", cancellationReason: "deadline", rowCount: 4 },
      failure,
    );

    const span = tracer.starts[0]!.span;
    strict.strictEqual(span.attributes["error.type"], "timeout");
    strict.strictEqual(span.attributes["typed_sql.cancellation.reason"], "deadline");
    strict.strictEqual(span.attributes["db.response.returned_rows"], 4);
    strict.deepStrictEqual(span.exceptions, [failure]);
    strict.deepStrictEqual(span.status, { code: SpanStatusCode.ERROR });
    strict.strictEqual(span.endCount, 1);
  });

  await it("uses batch conventions while keeping fingerprint arrays opt-in", () => {
    const tracer = new FakeTracer();
    const observation = startDatabaseObservation(
      createOpenTelemetryObserver({ tracer: tracer as unknown as Tracer, recordBatchFingerprints: true }),
      {
        kind: "batch",
        dialect: "mysql",
        grammarVersion: "1.0.0",
        transactionDepth: 0,
        fingerprints: ["sha256:a", "sha256:b"],
        size: 2,
      },
    )!;
    observation.end({ status: "success" });
    const started = tracer.starts[0]!;
    strict.strictEqual(started.name, "BATCH mysql");
    strict.strictEqual(started.span.attributes["db.operation.name"], "BATCH");
    strict.strictEqual(started.span.attributes["db.operation.batch.size"], 2);
    strict.deepStrictEqual(started.span.attributes["typed_sql.query.fingerprints"], ["sha256:a", "sha256:b"]);
  });

  await it("names pipeline and transaction spans without query text", () => {
    const tracer = new FakeTracer();
    const observer = createOpenTelemetryObserver({ tracer: tracer as unknown as Tracer });
    const pipeline = startDatabaseObservation(observer, {
      kind: "pipeline",
      dialect: "postgres",
      grammarVersion: "1.0.0",
      transactionDepth: 0,
      fingerprints: ["sha256:a"],
      size: 1,
    })!;
    pipeline.end({ status: "success" });
    const transaction = startDatabaseObservation(observer, {
      kind: "transaction",
      dialect: "mysql",
      grammarVersion: "1.0.0",
      transactionDepth: 1,
    })!;
    transaction.end({ status: "success" });

    strict.deepStrictEqual(
      tracer.starts.map(({ name }) => name),
      ["PIPELINE postgresql", "TRANSACTION mysql"],
    );
    strict.strictEqual(tracer.starts[0]?.span.attributes["db.operation.name"], "PIPELINE");
    strict.strictEqual(tracer.starts[1]?.span.attributes["db.operation.name"], "TRANSACTION");
  });

  await it("maps signal and ordinary errors to stable error.type values", () => {
    const tracer = new FakeTracer();
    const observer = createOpenTelemetryObserver({
      tracer: tracer as unknown as Tracer,
      recordExceptions: true,
    });
    const operation = {
      kind: "query",
      dialect: "mysql",
      grammarVersion: "1.0.0",
      transactionDepth: 0,
      fingerprint: "sha256:error",
      cardinality: "many",
      prepared: false,
    } as const;
    startDatabaseObservation(observer, operation)!.end({
      status: "cancelled",
      errorType: "TSQL_CANCELLED",
      cancellationReason: "signal",
    });
    startDatabaseObservation(observer, operation)!.end({ status: "error", errorType: "ER_LOCK_DEADLOCK" }, "safe");
    startDatabaseObservation(observer, operation)!.end({ status: "error" });

    strict.strictEqual(tracer.starts[0]?.span.attributes["error.type"], "cancelled");
    strict.strictEqual(tracer.starts[1]?.span.attributes["error.type"], "ER_LOCK_DEADLOCK");
    strict.strictEqual(tracer.starts[2]?.span.attributes["error.type"], "unknown");
    strict.deepStrictEqual(
      tracer.starts.flatMap(({ span }) => span.exceptions),
      [],
    );
  });

  await it("uses the globally registered no-op tracer when none is supplied", () => {
    const observer = createOpenTelemetryObserver({
      instrumentationName: "typed-sql-test",
      instrumentationVersion: "1.0.0",
    });
    const observation = startDatabaseObservation(observer, {
      kind: "transaction",
      dialect: "synthetic",
      grammarVersion: "1",
      transactionDepth: 1,
    })!;
    strict.strictEqual(
      observation.run(() => 42),
      42,
    );
    observation.end({ status: "success" });
  });
});
