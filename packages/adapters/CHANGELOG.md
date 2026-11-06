# @typed-sql/adapters

## 2.5.0-rc.0

### Minor Changes

- ab5e6d9: Add an explicit SQLite Wasm OO1 adapter with lossless INTEGER storage, compiled value-plan decoding, atomic batches and scoped asynchronous transactions. Preserve application ownership of the driver and storage VFS, finalize prepared statements, reject multiple SQL statements before execution, and expose a queryable for SQLite schema introspection.

### Patch Changes

- Updated dependencies [1b90678]
- Updated dependencies [81c8c46]
- Updated dependencies [a0c17a6]
  - @typed-sql/core@2.5.0-rc.0

## 2.4.0

### Patch Changes

- @typed-sql/core@2.4.0

## 2.4.0-rc.0

### Patch Changes

- Publish the coherent 2.4.0-rc.0 release-candidate train.

## 2.3.0

### Patch Changes

- Updated dependencies [b5808b9]
- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
  - @typed-sql/core@2.3.0

## 2.3.0-rc.2

### Patch Changes

- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
  - @typed-sql/core@2.3.0-rc.2

## 2.3.0-rc.1

### Patch Changes

- Updated dependencies [b5808b9]
  - @typed-sql/core@2.3.0-rc.1

## 2.3.0-rc.0

### Minor Changes

- b24279d: Add explicit buffered adapters for D1, libSQL/Turso, Neon HTTP, Neon WebSocket, and Postgres.js.
  Adapters enforce compiled value plans, transport precision, and truthful batch/transaction
  capabilities while leaving drivers application-owned. Add portable grammar query entrypoints and
  logical value descriptors without changing existing runtime entrypoint exports.

### Patch Changes

- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [19f37d9]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [19f37d9]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
  - @typed-sql/core@2.3.0-rc.0
