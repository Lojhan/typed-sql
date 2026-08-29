# @typed-sql/opentelemetry

## 2.0.0-rc.2

### Patch Changes

- Updated dependencies [7ea5d2f]
  - @typed-sql/core@2.0.0-rc.2

## 2.0.0-rc.1

### Patch Changes

- Publish the coherent 2.0.0-rc.1 release-candidate train.

## 2.0.0-rc.0

### Major Changes

- 1b054b6: Add an adapter-neutral, redacted database observation lifecycle for queries, cardinality contracts,
  batches, PostgreSQL pipelines, streams, cancellation, and nested transactions. Runtime fingerprints
  correlate with compiler structural variants while SQL, parameter values, connection configuration,
  and driver causes remain excluded by default. Publish the optional OpenTelemetry bridge with current
  database semantic conventions and explicit high-cardinality or exception-capture opt-ins.

### Patch Changes

- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [b06fd0a]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/core@2.0.0-rc.0

## 1.0.0

- Add an optional OpenTelemetry adapter for typed-sql's redacted database observation lifecycle.
