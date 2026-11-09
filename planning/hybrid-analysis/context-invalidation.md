# Native context invalidation evidence

This matrix distinguishes actual mutations from fields found during source review. A hashed
field is not, by itself, a passing invalidation test. All native mutation fixtures own their
disposable databases and restore or drop their changes. Application acquisition does not change
authorization, schema or session settings to manufacture a compatible context.

| Native profile | Authorization | Resolution environment | Semantic settings | Decoder policy | Engine boundary |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL 18.3 | Actual principal change and permission grant reject the old context | Actual search-path change rejects the old context | Actual time-zone change rejects the old context | Actual BIGINT policy change changes type-policy/codec identities and rejects reuse | Native acquisition supports 18; other qualified grammar majors reject acquisition in the native helper. An actual engine replacement is not tested here. |
| MySQL 8.4.11 / 9.7.2 | Principal is fingerprinted; an actual grant/principal mutation remains unverified | Database and session variables are fingerprinted; an actual database change remains unverified | SQL-mode guards and variable fingerprints exist; actual semantic-setting mutation remains unverified | Actual BIGINT policy change changes identities and rejects reuse on both engines | Both exact engines run independently; replacement using an old context remains unverified |
| DuckDB 1.5.6 / 2.0.0 | The supported owned embedded connection has no database-user authorization API; host file authorization is outside native metadata | Nondefault search paths are declined; actual path mutation remains unverified | Owned connection settings are guarded; actual setting mutation remains unverified | Actual BIGINT policy change changes identities and rejects reuse on both engines | Both SDK engines run independently; cross-engine reuse remains unverified |
| SQLite 3.53.4, Node 24.22.2 | The supported embedded connection has no database-user authorization API; host file authorization is outside native metadata | Worker authorizer admits the main database only; arbitrary attachments/search paths are outside the profile | Owned worker forces its declared read-only settings; setting mutation is outside the worker protocol | Actual integer policy change changes identities and rejects reuse | Actual version/source/compile-option evidence is fingerprinted; engine replacement remains unverified |
| SQL Server 14–17, ten compatibility pairs | New explicit/effective permission fingerprints and native grant/revoke regression await hosted qualification | Two-part ordinary local tables only; default-schema mutation remains unverified | Exact server evidence is checked; actual setting mutation remains unverified | New BIGINT policy mutation regression awaits hosted qualification on all ten pairs | Each exact engine/compatibility pair runs independently; replacement using an old context remains unverified |

PostgreSQL mutation proof is in [postgres-context-mutations.ts](../../test/helpers/postgres-context-mutations.ts).
It keeps the compiler schema fixed while changing the actual native environment, then attempts
acquisition with the original context. The permission case keeps the principal fixed. The codec
case keeps the native database context fixed. All return `context-mismatch` for the stale input.
Its existing native helper invokes the proof on the qualified PostgreSQL 18 profile.

Policy isolation is also asserted in the [MySQL native helper](../../test/helpers/mysql-native-contracts.ts),
[SQLite native suite](../../packages/sqlite/test/native-contracts.test.ts),
[DuckDB native suite](../../packages/duckdb/test/native-contracts.test.ts) and
[SQL Server native probe](../../e2e/sqlserver/native-contract-probe.mjs). Local complete helpers pass
on PostgreSQL 18.3 and MySQL 8.4.11/9.7.2; embedded suites pass on both DuckDB SDKs and SQLite.
The new SQL Server cases still require hosted execution.

SQL Server source review exposed a missing explicit-permission fingerprint: the principal token
alone did not account for a grant that left the principal and schema unchanged. Native contexts
now also include bounded database permission records and effective database/server permissions.
The effective-permission API accounts for direct and implied permissions, including role/group
membership ([Microsoft reference](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-my-permissions-transact-sql)).
Unit controls cover each evidence set and reject overlarge permission inventories. The native
regression grants SELECT to an otherwise unrelated database role, keeps the current principal
and compiler schema fixed, and requires the previous context to be rejected before revoking
the grant. Native adapter identity changes require regeneration of prior SQL Server contracts.

Schema/routine changes already have separate native evidence: PostgreSQL routine and table
mutations, MySQL table DDL, SQLite schema-version changes, DuckDB macro/catalog changes, and
SQL Server's guarded table/module descriptions. These do not substitute for the missing mutation
classes above. Permission-denied or unsupported context acquisition stays unavailable; it does
not certify an unchanged context. Acceptance scenario 8 remains open until the remaining
applicable mutations and exact profile runs are reconciled.
