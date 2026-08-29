---
"@typed-sql/core": major
"@typed-sql/opentelemetry": major
"@typed-sql/postgres": major
"@typed-sql/mysql": major
---

Add an adapter-neutral, redacted database observation lifecycle for queries, cardinality contracts,
batches, PostgreSQL pipelines, streams, cancellation, and nested transactions. Runtime fingerprints
correlate with compiler structural variants while SQL, parameter values, connection configuration,
and driver causes remain excluded by default. Publish the optional OpenTelemetry bridge with current
database semantic conventions and explicit high-cardinality or exception-capture opt-ins.
