# @typed-sql/sqlite

## 2.0.0-rc.0

### Minor Changes

- af27a0e: Add the experimental SQLite grammar with sound flexible-table storage unions, precise STRICT-table
  types, catalog snapshots for views, generated columns, indexes, foreign keys, and attached schemas,
  compound-query and RETURNING inference, and an optional application-owned `node:sqlite` adapter for
  prepared execution, nested transactions, ordered batches, and typed streams.
- e654fae: Add opt-in Standard Schema V1 result validation with compile-time output compatibility, immutable
  query attachment, sync and async validators, redacted fingerprinted errors, and consistent decoded-row
  handling across buffered cardinality methods, batches, PostgreSQL pipelines, streams, and transactions.

### Patch Changes

- 7023011: Support Node.js 22.11 and 22.12 by normalizing file URLs before opening `DatabaseSync` and using a
  buffered iterator when those Node releases do not yet provide `StatementSync.iterate()`.
- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [af27a0e]
- Updated dependencies [b06fd0a]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/ast@2.0.0-rc.0
  - @typed-sql/core@2.0.0-rc.0
  - @typed-sql/schema@2.0.0-rc.0

## 1.0.0-rc.0

### Minor Changes

- Add the preview SQLite grammar, sound flexible-table typing, catalog introspection, and optional
  application-owned `node:sqlite` adapter.
