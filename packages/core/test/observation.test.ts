import { describe, it, strict } from "poku";
import {
  type DatabaseObserver,
  type DatabaseOperationEnd,
  databaseErrorCompletion,
  observeQueryStream,
  QueryCancelledError,
  type QueryStream,
  startDatabaseObservation,
} from "../src/index.js";

const queryStart = {
  kind: "query",
  dialect: "synthetic",
  grammarVersion: "1",
  transactionDepth: 0,
  fingerprint: "sha256:test",
  cardinality: "one",
  prepared: false,
} as const;

const streamStart = {
  kind: "stream",
  dialect: "synthetic",
  grammarVersion: "1",
  transactionDepth: 0,
  fingerprint: "sha256:stream",
  prepared: false,
} as const;

await describe("redacted database observation lifecycle", async () => {
  await it("runs in observer context and emits one immutable duration-bearing completion", () => {
    const ends: DatabaseOperationEnd[] = [];
    const observer: DatabaseObserver = {
      start(operation) {
        strict.ok(Object.isFrozen(operation));
        strict.ok(!("text" in operation));
        strict.ok(!("values" in operation));
        return {
          run(callback) {
            return callback();
          },
          end(event) {
            ends.push(event);
          },
        };
      },
    };
    const observation = startDatabaseObservation(observer, queryStart)!;
    strict.strictEqual(
      observation.run(() => 42),
      42,
    );
    observation.end({ status: "success", rowCount: 1 });
    observation.end({ status: "error", errorType: "ignored" });
    strict.strictEqual(ends.length, 1);
    strict.strictEqual(ends[0]?.status, "success");
    strict.strictEqual(ends[0]?.rowCount, 1);
    strict.ok((ends[0]?.durationMilliseconds ?? -1) >= 0);
    strict.ok(Object.isFrozen(ends[0]));
    strict.ok(!("cause" in ends[0]!));
  });

  await it("isolates observer start/end failures and captures causes only by explicit opt-in", () => {
    strict.strictEqual(
      startDatabaseObservation(
        {
          start() {
            throw new Error("observer unavailable");
          },
        },
        queryStart,
      ),
      undefined,
    );

    const failure = new Error("driver text may be sensitive");
    let captured: DatabaseOperationEnd | undefined;
    const observation = startDatabaseObservation(
      {
        captureErrorCause: true,
        start() {
          return {
            end(event) {
              captured = event;
              throw new Error("exporter failed");
            },
          };
        },
      },
      queryStart,
    )!;
    strict.doesNotThrow(() => observation.end(databaseErrorCompletion(failure), failure));
    strict.strictEqual(captured?.cause, failure);
    strict.strictEqual(captured?.errorType, "Error");
  });

  await it("classifies stable typed-sql errors without serializing their messages", () => {
    const completion = databaseErrorCompletion(new QueryCancelledError("deadline"));
    strict.deepStrictEqual(completion, {
      status: "cancelled",
      errorType: "TSQL_CANCELLED",
      cancellationReason: "deadline",
    });
    strict.ok(Object.isFrozen(completion));
  });

  await it("observes lazy streams once across rows, early return, and repeated close", async () => {
    const ends: DatabaseOperationEnd[] = [];
    let starts = 0;
    let current = 0;
    const source: QueryStream<number> = {
      async next() {
        current += 1;
        return current <= 2 ? { done: false as const, value: current } : { done: true as const, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async close() {},
      async [Symbol.asyncDispose]() {},
    };
    strict.strictEqual(observeQueryStream(source, undefined, streamStart), source);
    const stream = observeQueryStream(
      source,
      {
        start() {
          starts += 1;
          return { end: (event) => ends.push(event) };
        },
      },
      streamStart,
    );
    strict.strictEqual(starts, 0);
    strict.deepStrictEqual(await stream.next(), { done: false, value: 1 });
    strict.strictEqual(starts, 1);
    await stream.return?.();
    await stream.close();
    strict.strictEqual(ends.length, 1);
    strict.strictEqual(ends[0]?.status, "success");
    strict.strictEqual(ends[0]?.rowCount, 1);
  });

  await it("ends a handled iterator throw when the source terminates", async () => {
    const ends: DatabaseOperationEnd[] = [];
    const failure = new Error("consumer failed");
    const source: QueryStream<number> = {
      async next() {
        return { done: false, value: 1 };
      },
      async throw() {
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async close() {},
      async [Symbol.asyncDispose]() {},
    };
    const stream = observeQueryStream(
      source,
      {
        start() {
          return { end: (event) => ends.push(event) };
        },
      },
      streamStart,
    );
    await stream.next();
    strict.deepStrictEqual(await stream.throw?.(failure), { done: true, value: undefined });
    strict.strictEqual(ends.length, 1);
    strict.strictEqual(ends[0]?.status, "error");
    strict.strictEqual(ends[0]?.errorType, "Error");
  });
});
