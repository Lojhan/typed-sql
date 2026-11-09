# Native context invalidation evidence

This matrix distinguishes actual mutations from fields found during source review. A hashed
field is not, by itself, a passing invalidation test. All native mutation fixtures own their
disposable databases and restore or drop their changes. Application acquisition does not change
authorization, schema or session settings to manufacture a compatible context.

| Native profile | Authorization | Resolution environment | Semantic settings | Decoder policy | Engine boundary |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL 18.3 | Actual principal change and permission grant reject the old context | Actual search-path change rejects the old context | Actual time-zone change rejects the old context | Actual BIGINT policy change changes type-policy/codec identities and rejects reuse | Native acquisition supports 18; other qualified grammar majors reject acquisition in the native helper. An actual engine replacement is not tested here. |
| MySQL 8.4.11 / 9.7.2 | Actual principal, direct grant, active role and effective role grant changes reject prior context | Actual selected-database change rejects prior context | Actual time-zone change rejects prior context; changed SQL mode declines qualification | Actual BIGINT policy change changes identities and rejects reuse on both engines | Both exact engines run independently; replacement using an old context remains unverified |
| DuckDB 1.5.6 / 2.0.0 | The supported owned embedded connection has no database-user authorization API; host file authorization is outside native metadata | Actual nondefault search-path mutation declines context inspection and old-context acquisition | Actual integer-division setting mutation changes the native result type and rejects prior context with unchanged compiler schema and codec policy | Actual BIGINT policy change changes identities and rejects reuse on both engines | Each engine acquires its own context and rejects the other engine's recorded context, in separate processes with the same compiler schema/policy |
| SQLite 3.53.4, Node 24.22.2 | The supported embedded connection has no database-user authorization API; host file authorization is outside native metadata | Worker authorizer admits the main database only; arbitrary attachments/search paths are outside the profile | Owned worker forces its declared read-only settings; setting mutation is outside the worker protocol | Actual integer policy change changes identities and rejects reuse | Actual version/source/compile-option evidence is fingerprinted; engine replacement remains unverified |
| SQL Server 14–17, ten compatibility pairs | Actual grant/revoke and distinct-login impersonation reject prior context on all ten pairs; login names and SIDs are fingerprinted | Two-part ordinary local tables only; same-principal default-schema mutation fixture is implemented, with hosted proof pending | Actual DATEFIRST mutation declines inspection and old-context acquisition on all ten pairs | Actual BIGINT policy mutation rejects prior context on all ten pairs | Each exact engine/compatibility pair runs independently; replacement using an old context remains unverified |

PostgreSQL mutation proof is in [postgres-context-mutations.ts](../../test/helpers/postgres-context-mutations.ts).
It keeps the compiler schema fixed while changing the actual native environment, then attempts
acquisition with the original context. The permission case keeps the principal fixed. The codec
case keeps the native database context fixed. All return `context-mismatch` for the stale input.
Its existing native helper invokes the proof on the qualified PostgreSQL 18 profile.

The [MySQL mutation helper](../../test/helpers/mysql-context-mutations.ts) performs direct and
effective role grants, enables a role, switches to a separately created principal, changes the
selected database and time zone, and checks a mismatched SQL mode. Both 8.4.11 and 9.7.2 pass
these local native assertions. Each context-change case holds compiler schema identity fixed
and rejects the original context. The helper restores grants and drops its own role/account;
the role name includes a backtick to exercise native metadata quoting.

MySQL native context now includes bounded direct grants, enabled roles and effective role
grants. Role identities come from structured native metadata and are quoted separately; a
rendered `CURRENT_ROLE()` string is never spliced into a statement. The actual privilege
statements are only hashed into context identity, never executed or promoted into routine rules.
MySQL documents `SHOW GRANTS ... USING` as the mechanism for including role-derived privileges
([vendor reference](https://dev.mysql.com/doc/refman/8.4/en/show-grants.html)). Missing, malformed,
overlarge or denied metadata fails qualification. The native adapter identity advances to v3.

Policy isolation is also asserted in the [MySQL native helper](../../test/helpers/mysql-native-contracts.ts),
[SQLite native suite](../../packages/sqlite/test/native-contracts.test.ts),
[DuckDB native suite](../../packages/duckdb/test/native-contracts.test.ts) and
[SQL Server native probe](../../e2e/sqlserver/native-contract-probe.mjs). Local complete helpers pass
on PostgreSQL 18.3 and MySQL 8.4.11/9.7.2; embedded suites pass on both DuckDB SDKs and SQLite.
SQL Server permission/codec mutation cases and cleanup pass on all ten pairs in [run 42597621667](https://github.com/Lojhan/typed-sql/actions/runs/42597621667).

DuckDB's actual session mutations now pass on both SDKs. The setting test changes
`integer_division` before the owned acquisition starts, keeps the compiler schema/codec fixed,
verifies that the native result identity changes and refuses the old context. Nondefault search
paths remain unsupported rather than inheriting default-path evidence. The declared-profile
runner discovers every pinned engine from the owner policy/package manifest, captures each
actual context in a separate process and verifies every cross-engine pair. Each engine still
acquires its own context; a context from the other engine yields `context-mismatch`. This does
not claim compatibility of database files created by different engines. Node native SDKs never
share a process.

SQL Server source review exposed a missing explicit-permission fingerprint: the principal token
alone did not account for a grant that left the principal and schema unchanged. Native contexts
now also include bounded database permission records and effective database/server permissions.
The effective-permission API accounts for direct and implied permissions, including role/group
membership ([Microsoft reference](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-my-permissions-transact-sql)).
Unit controls cover each evidence set and reject overlarge permission inventories. The native
regression grants SELECT to an otherwise unrelated database role, keeps the current principal
and compiler schema fixed, and requires the previous context to be rejected before revoking
the grant. Native adapter identity changes require regeneration of prior SQL Server contracts.

The login identity review additionally finds that a database token alone does not identify the
current server login when multiple sysadmins map to `dbo`. Contexts now fingerprint validated
original/current login names, login SID, database-user name and SID. Unit controls hold other
context facts fixed, mutate every identity field and reject prior contexts; missing, malformed
and overlarge metadata are unavailable. The adapter identity advances to v4. The actual native
probe creates a disposable server login before baseline capture, impersonates it on an owned
exclusive lease and requires old-context rejection with unchanged compiler schema and codec.
It also changes DATEFIRST and requires unsupported-context failure. Login/database cleanup is
recorded even on failure. All new cases pass on all ten hosted engine/compatibility pairs in [run 42610820237](https://github.com/Lojhan/typed-sql/actions/runs/42610820237). The artifacts record 150 passed native cases and successful database/login cleanup. The native cost/facet records are refreshed from the tested v4 producer; earlier v3 observations remain historical evidence.

The default-schema regression now uses a separate non-sysadmin login with a mapped database
user and owned metadata permissions. SQL Server ignores DEFAULT_SCHEMA for sysadmins
([ALTER USER reference](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-user-transact-sql)),
so changing the existing sysadmin fixture would not prove a resolution change. The fixture
records the actual default schema, database user, current login and non-sysadmin status before
and after ALTER USER; it requires that only the default schema changes in that evidence. It
holds compiler schema/codec identities fixed, acquires before the change, rejects the old
context after the change and acquires with the fresh context. The default schema is restored,
and the owned login is dropped even on failure. Server-state permissions follow the actual
engine requirement ([metadata API reference](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-connections-transact-sql)).
A unit control changes only the native default-schema field and verifies rejection before any
candidate-description call. The context controls record bounded acquisition attempts and retry
only a classified `context-changed` guard race, keeping the supplied old context unchanged.
The required stale-context rejection remains asserted; permissions, timeouts and other errors
are never converted into successful outcomes. This is implemented regression coverage; all ten actual hosted
executions are still required before the mutation matrix can claim native proof.

Schema/routine changes already have separate native evidence: PostgreSQL routine and table
mutations, MySQL table DDL, SQLite schema-version changes, DuckDB macro/catalog changes, and
SQL Server's guarded table/module descriptions. These do not substitute for the missing mutation
classes above. Permission-denied or unsupported context acquisition stays unavailable; it does
not certify an unchanged context. Acceptance scenario 8 remains open until the remaining
applicable mutations and exact profile runs are reconciled.
