# @typed-sql/opentelemetry

Optional OpenTelemetry tracing for typed-sql's redacted database observer contract.

This package has a stable public contract. The OpenTelemetry API is an application-owned peer;
typed-sql does not install an SDK or exporter.

```sh
pnpm add @typed-sql/opentelemetry @opentelemetry/api
```

```ts
import { createOpenTelemetryObserver } from "@typed-sql/opentelemetry";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  observer: createOpenTelemetryObserver(),
});
```

The default attributes contain a stable query fingerprint, dialect, grammar version, execution kind,
cardinality contract, and transaction depth. SQL text, parameter values, connection strings, driver
errors, batch fingerprint lists, and returned-row counts are excluded by default.

See the [observability guide](../../docs/guides/observability.md) for lifecycle semantics, opt-ins,
custom observers, and complete tracing setup.

MIT © typed-sql contributors
