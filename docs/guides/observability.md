---
title: Observe database work
description: Trace typed-sql queries, batches, pipelines, streams, and transactions without logging SQL values.
---

# Observe database work

typed-sql exposes one adapter-neutral database observer contract and an optional OpenTelemetry bridge. Observation is disabled unless an observer is passed to a database adapter. The disabled query path does not hash a query, construct an event, or wrap a stream.

## Add OpenTelemetry tracing

Install the bridge and the OpenTelemetry API alongside the driver owned by your application:

```sh
pnpm add @typed-sql/opentelemetry @opentelemetry/api
```

Pass one observer when the database is created:

```ts
import { createOpenTelemetryObserver } from "@typed-sql/opentelemetry";
import { typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  typePolicy,
  observer: createOpenTelemetryObserver(),
});
```

The bridge uses the globally registered OpenTelemetry tracer provider by default. SDK setup and export remain application-owned. For example, an application exporting OTLP over HTTP can initialize its provider before creating the database:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

const telemetry = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
});

telemetry.start();
```

Queries then run in their span context, so child work started during driver dispatch can use the active database span. Call `telemetry.shutdown()` during application shutdown according to the SDK lifecycle used by the application.

## Default span policy

The integration follows the current OpenTelemetry SQL database span conventions: database work uses client spans, `db.system.name` identifies the database system, and group operations use low-cardinality operation names.

Default spans contain only structural metadata:

- dialect and grammar version;
- operation kind and transaction depth;
- one query fingerprint, cardinality contract, and prepared status for query operations;
- batch or pipeline size;
- stable error type and cancellation reason when an operation fails.

The following data is absent by default:

- SQL text and rendered literals;
- parameter values;
- connection strings, hostnames, credentials, and pool configuration;
- driver error objects or messages;
- batch fingerprint arrays and returned-row counts.

Returned-row counts and batch fingerprint arrays are OpenTelemetry opt-ins because they can add cost or cardinality. Driver exception recording is a separate, visibly unsafe opt-in because driver messages may contain SQL or values:

```ts
const observer = createOpenTelemetryObserver({
  recordReturnedRows: true,
  recordBatchFingerprints: true,
  recordExceptions: true, // Review driver error redaction before enabling this.
});
```

`recordExceptions` is the only option that asks core to carry the original error object to the integration. It should not be enabled until the application's driver and exporter redaction behavior has been reviewed.

## Lifecycle semantics

An installed observer receives one start event and at most one end event for each operation it accepts.

| Operation | Starts | Ends |
| --- | --- | --- |
| `execute`, `all`, `one`, `maybeOne` | Before driver dispatch | Success, cardinality error, driver error, or cancellation |
| `batch` | Once for the ordered group | After the group succeeds or fails |
| PostgreSQL `pipeline` | Once for the dispatched group | After every response settles |
| `stream` | Lazily on first iteration | Natural completion, error, cancellation, explicit close, disposal, or early iterator return |
| `transaction` | Before begin or savepoint work | After commit/release succeeds, or rollback failure is reported |

Nested transaction events use depth `1` for the first transaction and increase for each savepoint. Query and stream events inside a transaction carry that same depth. Observer `start()` and `end()` failures are isolated from database results. An observer can return `undefined` from `start()` to decline one operation.

## Correlate compiler and runtime work

A runtime query fingerprint is SHA-256 over the dialect id, grammar version, and rendered structural SQL. Parameter values and checkout paths are not inputs.

For an unconditional query, the runtime fingerprint equals `CompiledQuery.fingerprint`. A conditionally composed query can produce several complete structural statements; its runtime fingerprint equals one member of `CompiledQuery.variantFingerprints`. The compiled query's top-level fingerprint is the deterministic identity of that complete variant set. This lets generated manifests index runtime spans without storing SQL or values.

Fingerprints are stable correlation identifiers, not authorization tokens or cryptographic attestations.

## Install a custom observer

Use the core contract when an application already has a metrics or logging abstraction:

```ts
import type { DatabaseObserver } from "@typed-sql/core";

const observer: DatabaseObserver = {
  start(operation) {
    const startedAt = performance.now();

    return {
      run(callback) {
        return callback();
      },
      end(completion) {
        metrics.databaseOperation.record(completion.durationMilliseconds, {
          dialect: operation.dialect,
          kind: operation.kind,
          status: completion.status,
        });
      },
    };
  },
};
```

Start events and completion events are frozen. Keep metric dimensions low-cardinality: dialect, operation kind, status, and cancellation reason are suitable defaults. A query fingerprint is useful for tracing and targeted diagnostics, but it should not normally become an unbounded metrics label.

See [Query API](../reference/api.md#database-observation) and the [PostgreSQL](../dialects/postgresql.md) or [MySQL](../dialects/mysql.md) runtime notes.
