# @typed-sql/migrations

## 3.0.0-rc.0

### Minor Changes

- 4de04fc: Add explicit SQL and TypeScript migration control with independently replayed schema evidence, blocking drift detection, global/local checks, PostgreSQL locking and history, schema reconciliation, baseline adoption and inspected recovery.

### Patch Changes

- 825eba3: Add optional historical catalog display details with validated object identities. PostgreSQL targets can opt in with captureDetails to retain safe structural column, enum, index and constraint metadata while preserving existing drift fingerprints and hash-only history. Routine bodies, default literals and expression SQL remain excluded.
- Updated dependencies [63e76b2]
- Updated dependencies [4de04fc]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [825eba3]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
  - @typed-sql/core@3.0.0-rc.0

## Unreleased

- Introduce driver-neutral migration authoring, plans, lifecycle checks, independent replay evidence, schema drift enforcement and explicit recovery.
