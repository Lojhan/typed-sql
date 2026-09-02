---
title: MySQL
description: MySQL grammar coverage, catalog introspection, application-owned mysql2 integration, and deliberate limitations.
---

# MySQL

`@typed-sql/mysql` contains the MySQL grammar, catalog model, resolver, type policy, and runtime codecs. The optional `@typed-sql/mysql/mysql2` entrypoint loads the `mysql2` driver installed by your application.

## Public entrypoints

- `@typed-sql/mysql` — `sql`, dialect factory, default type policy, analysis, type mapping, semantic routing, and transaction retry classification.
- `@typed-sql/mysql/runtime` — driver-neutral rendering and codec utilities.
- `@typed-sql/mysql/mysql2` — schema provider, executable database adapter, lazy live verifier, and structured-plan inspector for application-owned `mysql2`.

## Supported SQL

The grammar targets the supported MySQL 8.4 and 9.7 LTS series and supports:

- aliases, stars, and inner, outer, or cross joins;
- ordinary and recursive CTEs, derived tables, and correlated or `LATERAL` subqueries;
- `UNION`, `INTERSECT`, and `EXCEPT` across `SELECT`, `TABLE`, and `VALUES` query forms, including MySQL precedence and parenthesized arms;
- mode-aware grouping, both `ROLLUP` forms, aggregates, named/framed windows, and `CASE`;
- scalar, `EXISTS`, `IN`, and `BETWEEN` expressions;
- common JSON functions and operators;
- `INSERT` from `VALUE(S)`, `VALUES ROW`, `SET`, `SELECT`, or `TABLE`, including priorities,
  `IGNORE`, partition selection, inserted-row aliases, and `ON DUPLICATE KEY UPDATE`;
- `REPLACE` value, set, and query forms, with generated-column `DEFAULT` restrictions;
- single- and multi-table `UPDATE` and `DELETE`, including joined namespaces, writable-target
  validation, and the single-table-only `ORDER BY` and `LIMIT` tails;
- ordered parameters inferred from comparisons, DML targets, casts, ranges, limits, and cataloged function arguments.

Catalog inference covers enums, unsigned integers, decimals, JSON, temporal types, binary values, and configurable `tinyint(1)` mapping.

The package ships immutable generated built-in catalogs for the supported `8.4` and `9.7` LTS
series and the `26.7` canary. Catalog revisions are recorded in schema snapshots, so a catalog
change participates in artifact and schema compatibility instead of silently changing inference.
Version-gated types and functions fail closed; for example, `VECTOR` and `VECTOR_DIM()` are
available from the 9.x catalog and are rejected for an 8.4 snapshot. The checked-in catalog source
owns type families, coercion safety, operators, built-in result rules, and supported collations.

Character-set introducers and explicit `COLLATE` expressions preserve source spans and resolve
MySQL coercibility. Explicit collations outrank columns and literals; equal-coercibility Unicode and
binary-collation tie-breaking follows MySQL rules, while incompatible or unknown combinations are
diagnostics. Exact collation analysis requires v2 column charset/collation evidence plus connection
charset/collation evidence. Valid collations not yet present in the reviewed catalog remain
conservative rather than being accepted optimistically.

Numeric expressions distinguish integer, decimal, and approximate families. Decimal operands stay
under the configured decimal policy, approximate operands produce `number`, and integer arithmetic
preserves unsigned evidence. `NO_UNSIGNED_SUBTRACTION` changes subtraction to a signed result.
Division of exact values is nullable because division by zero returns `NULL`.

## Version support and differential evidence

The stable contract is patch-compatible within the MySQL 8.4 and 9.7 LTS series. Protected CI runs
the exact 8.4.12 and 9.7.3 images. Each LTS patch runs a default profile, a lexical profile with
`ANSI_QUOTES`, `NO_BACKSLASH_ESCAPES`, and `PIPES_AS_CONCAT`, and a numeric profile with
`NO_UNSIGNED_SUBTRACTION`. All six LTS jobs are release-blocking.

Those profiles contain the modeled SQL modes published by `MYSQL_SUPPORT_POLICY`. A custom profile
made only from modeled modes keeps exact capability evidence because the snapshot supplies the
normalized set before parsing. If a profile adds a mode whose lexical or semantic effect is not
modeled, supported capabilities resolve conservatively and query analysis fails closed with
`TSQ407`; typed-sql does not assume the extra mode is harmless.

MySQL 26.7.1 runs separately with `versionPolicy: "canary"`. It reports innovation-line catalog,
keyword, collation, syntax, protocol, decoding, and introspection differences against the 9.7
default profile, but it does not contribute to the stable score. A canary failure therefore exposes
future work without changing the published LTS support boundary.

Every matrix target generates its own schema format 2 snapshot and a redacted differential artifact.
The artifact proves the exact Oracle MySQL product and patch, normalized `sql_mode`, catalog
revision, snapshot identity, built-in collation coverage, text/prepared protocol parity, runtime
codec parity, warning inspection, and disabled multi-statement execution. The stable review fails on
a missing target, duplicate profile, unexpected stable target, or any failed probe.

## Schema introspection

MySQL introspection writes schema format 2 and records the `def` catalog, selected databases,
tables and views, column order and write eligibility, generated and invisible columns,
auto-increment identity, character sets and collations, numeric and temporal precision, unsigned
and zerofill attributes, enum and set members, and spatial reference identifiers. Constraint
evidence includes ordered primary, unique, foreign-key, and check definitions plus check
enforcement. Index evidence distinguishes optimizer visibility from validity and records ordered or
functional key parts, prefix lengths, direction, method, uniqueness, and column collation.

Stored routine evidence includes ordered `IN`, `OUT`, and `INOUT` parameters, result types,
determinism, data access, security mode, creation `sql_mode`, and creation/result charset and
collation metadata. The snapshot records normalized server identity and settings, current-role
catalog scope, the versioned built-in catalog revision, and that temporary tables are not captured.
MariaDB and unidentified MySQL-compatible products are rejected instead of being interpreted as
Oracle MySQL.

`MySqlSchemaProvider.introspectWithDiagnostics()` returns the snapshot with any permission-limited
catalog warnings. A failed optional catalog read produces `TSQ406`, marks that catalog as
`incomplete` in the snapshot extension, and omits unsafe positive evidence. Essential server and
database discovery still fail when no usable target can be established. `introspect()` preserves
the ordinary `SchemaProvider` contract and returns the same fail-closed snapshot.

Schema introspection records normalized `sql_mode` before scanning. `ANSI_QUOTES` selects quoted
identifiers, `NO_BACKSLASH_ESCAPES` changes string-literal decoding, and `PIPES_AS_CONCAT` changes
`||` from logical OR to concatenation. A snapshot without mode evidence remains conservative.
`mysql({ versionPolicy: "canary" })` explicitly selects the grammar-owned canary line; prereleases
never satisfy stable LTS ranges.

`createMySql2LiveVerifier()` reads binary `COM_STMT_PREPARE` parameter and result metadata and closes the statement without executing it or sending values. See [Live verification](../guides/live-verification.md).

`createMySql2PlanInspector()` uses JSON `EXPLAIN` without `ANALYZE`. Parameterized statements require application-supplied transient samples; normalized evidence excludes conditions and literals. See [Query plan governance](../guides/query-plan-governance.md).

`createMySqlRoutedDatabase()` composes application-owned databases and parses runtime query shapes with the MySQL grammar. Stable, non-locking reads may use a supplied replica. `FOR UPDATE`, `FOR SHARE`, legacy `LOCK IN SHARE MODE`, writes, volatile functions, session state, and unknown statements use primary. `isMySqlRetryableTransactionError()` recognizes InnoDB deadlock identity and deliberately excludes lock-wait timeout `1205`. See [Route reads and retry transactions](../guides/routing-and-retries.md).

Invalid recursive members, compound-query ordering, lateral scope, named or framed windows, and
`ONLY_FULL_GROUP_BY` references fail closed with stable diagnostics. `FULL JOIN`, array constructors,
aggregate `FILTER`, and incompatible `RETURNING` clauses remain unsupported. Commands without a
result surface infer `Query<never, Parameters>`. Unknown functions warn and infer `unknown`;
ambiguous or structurally unsafe queries are errors.

MySQL still recognizes `INSERT DELAYED` and `REPLACE DELAYED` but executes them without delayed
behavior. Analysis accepts these value forms with a warning. `DELAYED` query sources and
`HIGH_PRIORITY REPLACE` are rejected because they are outside the supported server grammar. The
deprecated `VALUES(column)` duplicate-key reference also emits a warning; inserted-row aliases keep
the same target-column inference without relying on deprecated syntax.

PostgreSQL's recursive-CTE `SEARCH`/`CYCLE`, function-relation `ROWS FROM`/`WITH ORDINALITY`, and
`TABLESAMPLE` clauses are rejected as unsupported syntax. MySQL `JSON_TABLE` row sources also remain
unsupported and fail closed; the live differential probe records server acceptance without
promoting that syntax into the grammar.

## Runtime behavior

The adapter controls mysql2 options that affect row shape, decoding, statement caching, and protocol safety. Supplying conflicting `poolConfig` options such as `typeCast`, `rowsAsArray`, `maxPreparedStatements`, `multipleStatements`, or incompatible bigint, decimal, date, or JSON settings fails before a pool is created. Connection, TLS, timeout, and pool-capacity settings remain application-owned. Multi-statement strings stay disabled; use `database.batch()` for ordered commands.

`database.prepare(name, factory)` returns ordinary queries carrying instance-local prepared metadata. MySQL execution uses mysql2's binary `execute()` path and its per-connection prepared-statement cache. The factory caches its first structural SQL skeleton and rejects duplicate names or structural drift between calls. `preparedStatementLimit` bounds both the database's logical registrations and mysql2's per-connection LRU; it defaults to 16,000. The runtime rejects a new logical name at the bound instead of evicting a factory that application code may still hold. `decoderPlanCacheCapacity` independently bounds compiled row-decoder metadata.

Pass a generated schema format 2 value as `compatibilitySnapshot` to verify every leased physical connection before application SQL is sent. The mysql2 adapter reads the actual Oracle MySQL product, normalized version, SQL mode, server and connection character sets and collations, time zones, edition, and identifier-casing mode from that session. A reconnect or session drift is checked again on its next dispatch. Missing evidence, MariaDB or proxy identity, a grammar-version mismatch, and any semantic-setting mismatch throw `MySqlRuntimeCompatibilityError` without including SQL, parameters, or connection details.

For buffered and batched execution, `onWarning` receives `{ count, fingerprint }` separately from query errors. The fingerprint is redacted and compiler-compatible; SQL and values are never included. `rejectWarnings: true` throws `MySqlWarningError` after a warning-producing command. For result sets, mysql2 reads the session warning count on the same lease; a custom adapter that cannot provide warning evidence fails before dispatch with `MySqlWarningInspectionError` when warning handling is enabled.

`database.batch(queries)` leases one mysql2 connection and calls `execute()` sequentially for every query, preserving mysql2's per-connection prepared cache and typed-sql's result decoding. It is not a multi-statement string or one protocol round trip. Root batches use ordinary autocommit behavior. Transactional statements can use an explicit typed-sql transaction when atomicity is required; MySQL operations that implicitly commit, such as DDL, retain their native semantics.

`all`, `one`, and `maybeOne` accept an `AbortSignal` and absolute deadline. mysql2 has no per-command `AbortSignal` contract, so typed-sql interrupts a buffered query by destroying its checked-out connection. The pool replaces it for later work, while a cancelled transaction is invalidated and cannot continue.

The runtime constructors and mysql2 adapter accept a grammar-neutral `observer`. Query, prepared-query, batch, stream, cancellation, and nested-transaction lifecycles carry MySQL compiler-compatible fingerprints without exposing SQL or values. See [Observe database work](../guides/observability.md).

## Upgrade and compatibility review

Regenerate the schema snapshot and query manifest after changing the MySQL server line, `sql_mode`,
connection charset or collation, time zone, type policy, or typed-sql version. Then run
`typed-sql compat` with the before and after artifacts. Catalog and coercion corrections can narrow an
`unknown` result, change a numeric or collation result, or introduce a fail-closed diagnostic; the
compatibility report identifies affected queries in both rolling-deployment directions.

MySQL warnings are runtime evidence rather than schema drift. Exercise representative writes with
`onWarning` during an upgrade, or use `rejectWarnings` when warnings are deployment failures. This
is especially important when a server or mode change turns coercion, truncation, zero-date, or
deprecated syntax behavior from a warning into an error. See
[Migration compatibility](../guides/migration-compatibility.md) and
[Database type mappings](../reference/type-mappings.md).

## Bulk transfer

The package root exports the `mysqlBulk` capability token. The mysql2 adapter implements
`loadData()` with `LOAD DATA LOCAL INFILE`, but supplies the infile stream from the application's
typed row source and rejects every path except its fixed internal sentinel. It never opens an
arbitrary local or server-provided path. The MySQL server must explicitly enable `local_infile`.

The input remains an ordinary typed single-row `INSERT` factory. Stable text-safe scalar values use
an escaped UTF-8 tab stream with bounded buffering. Binary, structured, and connection-timezone
dependent Date values fail closed and should use normal parameter execution. No native bulk export capability is claimed. See
[Transfer bulk data](../guides/bulk-data.md).

## Streaming

MySQL streaming uses mysql2's protocol-backed execute stream and does not require another package. `batchSize` maps to the object-mode high-water mark, so it controls client-side buffering rather than server cursor page size.

An early `break`, `close()`, or async disposal stops delivering rows to the consumer, then waits for mysql2 to drain the remaining protocol response before releasing the connection. It does not claim to cancel the running MySQL statement. A connection is reused only after the native command finishes successfully; protocol failures keep it out of the reusable pool path.

Inside a transaction, the stream reuses the transaction connection and never releases it directly. The stream must complete or close before the transaction callback returns.

See [Execute queries](../guides/execution.md), [Route reads and retry transactions](../guides/routing-and-retries.md), [Database type mappings](../reference/type-mappings.md#mysql), and [Compatibility](../reference/compatibility.md).
