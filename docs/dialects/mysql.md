---
title: MySQL
pageType: reference
description: MySQL grammar coverage, catalog introspection, application-owned mysql2 integration, and deliberate limitations.
---

# MySQL

`@typed-sql/mysql` provides the `sql` tag, rendering and runtime type policy. Offline analysis uses the explicit entrypoints below. The optional `@typed-sql/mysql/mysql2` entrypoint loads the `mysql2` driver installed by your application.

## Selected-series offline analysis

Use an explicit series analyzer to retain that series' existing offline rules:

```ts
import { mysql } from "@typed-sql/mysql/analysis/9.7";

export const dialect = mysql();
```

The selected analyzer requires explicit matching snapshot version evidence. Patch compatibility
and SQL-mode/edition checks follow the existing support policy. The general
`@typed-sql/mysql/analysis` import retains its supported series and offline behavior.

| Import | Scope |
| --- | --- |
| `@typed-sql/mysql/analysis/8.4` | Full offline 8.4 analyzer |
| `@typed-sql/mysql/analysis/9.7` | Full offline 9.7 analyzer |
| `@typed-sql/mysql/analysis/26.7` | Full offline canary-series analyzer; requires `versionPolicy: "canary"` |
| `@typed-sql/mysql/analysis/core/8.4` | Bounded offline 8.4 core |
| `@typed-sql/mysql/analysis/core/9.7` | Bounded offline 9.7 core |
| `@typed-sql/mysql/analysis/core/26.7` | Bounded offline canary core; requires the canary policy |

For common SQL and [generated query contracts](../guides/query-manifests.md), select a core:

```ts
import { mysql } from "@typed-sql/mysql/analysis/core/9.7";

export const dialect = mysql();
```

The core retains all existing maintained routine families plus type, coercion, collation,
operator, JSON and structural-expression rules. This set already fits the compact-core scope;
there is no separate MySQL compatibility data pack. Selecting one series excludes other full
catalogs. Shared compact runtime codec/type metadata and cross-series availability vocabulary
remain available.

An unmapped function produces `TSQ408` with guidance to
[generate a qualified query contract](../guides/query-manifests.md). Argument analysis retains
casts and parameter order. Unsupported versions, SQL modes, editions and ambiguous calls remain
blocking. Native generation needs explicit configuration and does not occur on import.

The full analyzer entrypoints retain their existing diagnostic behavior, including a warning
and unknown result for unrecognized functions. Core entrypoints request a qualified contract for
that case. Neither import installs or initializes a driver. Application queries continue to
import `sql` from `@typed-sql/mysql`.


## Keyword and function-name contexts

Each selected series consumes compact keyword metadata generated from pinned lexical, grammar and
native-dispatch declarations. Reserved words require quoting in ordinary identifier positions;
qualified names and aliases follow their respective grammar rules. Special function names also
depend on the following parenthesis, intervening whitespace and `IGNORE_SPACE`. Quoting or spacing
a special name can select an ordinary routine instead of its built-in rule. Such calls retain
argument evidence and require an applicable routine declaration or qualified query contract.

Normal builds and offline checks do not fetch upstream sources. Runtime tags and frozen contract
consumption do not load the keyword inventory. Inventory recognition does not imply support for
every associated SQL production or a universal function signature.

## Public entrypoints

- `@typed-sql/mysql/profile` — driver-free `mysqlProfile()` for [query contract consumption](../guides/query-manifests.md#consume-durable-query-contracts-in-a-compiler-host), without semantic catalogs or an analyzer loader.

- `@typed-sql/mysql/query` — portable `sql`, renderer, and runtime value descriptors for buffered adapters.

- `@typed-sql/mysql` — `sql`, runtime plan primitives, renderer and type policy.
- `@typed-sql/mysql/analysis` — explicit eager analyzer and compatibility exports, including schema introspection and semantic routing.
- `@typed-sql/mysql/runtime` — driver-neutral rendering and codec utilities.
- `@typed-sql/mysql/mysql2` — schema provider, executable database adapter, lazy live verifier, and structured-plan inspector for application-owned `mysql2`.
- `@typed-sql/mysql/mysql2-contracts` — explicit native query-contract acquisition through an owned `mysql2` connection.
- `@typed-sql/mysql/contract-profile` — driver-free query-contract identity and reconciliation-owner declarations.
- `@typed-sql/mysql/reconciliation` — independent comparison of offline claims and native descriptions.

## Native query contracts

`createMySql2NativeContractAdapter({ connectionUri, schema, typePolicy })` describes builtin
expressions and guarded table queries using binary preparation. Use the generated versioned schema with its
recorded SQL mode, `mySqlContractIdentity()` and `createMySqlContractReconciler()` with the
[query contract configuration](../guides/query-manifests.md). Importing the adapter does not open
a connection or load the optional driver; acquisition is explicit.

The qualified native targets are MySQL 8.4.11 and 9.7.2. Each acquisition owns a fresh connection,
holds `LOCK INSTANCE FOR BACKUP`, and prepares within a read-only transaction. The qualification
account needs `BACKUP_ADMIN`, access to the selected schema and read access to the relevant
`performance_schema` metadata. The backup lock holds conflicting DDL until the short acquisition
lease closes; ordinary row writes can proceed. Deadlines and cancellation close the owned
connection and release its lock. Candidate SQL is never bound, executed or supplied sample values.

The adapter accepts ordinary `?` parameters in occurrence order, builtin expression projections,
ordinary InnoDB table projections, stars, filters and joins. Referenced tables must belong to the
selected database, use `lower_case_table_names=0` and have no generated columns. The adapter checks
live dictionary metadata before preparing the candidate. Views, other storage engines, explicit
partition selectors, subqueries, stored/loadable routines, window clauses, executable comments
and structural session operations remain outside this profile. Unsupported shapes and unavailable
metadata fail closed. Native rejection reflects the actual target engine's available functions.

The context includes table and column definitions captured under the backup lock. It excludes
row counts and other data statistics: ordinary row writes preserve the context, while table DDL
changes it even if the supplied schema has not been refreshed. Acquisition admits at most 4,096
visible tables and 65,536 visible columns in the selected database; larger dictionaries report
unavailable metadata. The existing routine/UDF limits and acquisition deadline still apply.

Decimal dimensions, unsigned integer identity and text/binary distinctions are preserved.
Absence of a native non-null flag supplies a conservative nullable bound.
String and temporal wire families retain partial native identities where dimensions or collations
are not established. The configured required qualification facets determine whether that evidence
is sufficient. Parameter metadata remains independent of result casts, and missing input facts
cannot become usable parameter types. Matching exported contracts support disconnected checking.

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
the exact 8.4.11 and 9.7.2 images. Each LTS patch runs a default profile, a lexical profile with
`ANSI_QUOTES`, `NO_BACKSLASH_ESCAPES`, and `PIPES_AS_CONCAT`, and a numeric profile with
`NO_UNSIGNED_SUBTRACTION`. All six LTS jobs are release-blocking.

Those profiles contain the modeled SQL modes published by `MYSQL_SUPPORT_POLICY`. A custom profile
made only from modeled modes keeps exact capability evidence because the snapshot supplies the
normalized set before parsing. If a profile adds a mode whose lexical or semantic effect is not
modeled, supported capabilities resolve conservatively and query analysis fails closed with
`TSQ407`; typed-sql does not assume the extra mode is harmless.

MySQL 26.7.0 runs separately with `versionPolicy: "canary"`. It reports innovation-line catalog,
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

`createMySql2Database` reads JSON as text and applies the selected JSON policy itself. This keeps
mysql2's BIGINT conversion from turning JSON numbers into strings while preserving exact ordinary
BIGINT decoding. Custom `MySqlPoolLike` implementations can declare `jsonWire: "text"` for raw JSON
cells or `jsonWire: "parsed"` for already decoded JSON values. This distinguishes a parsed JSON
scalar such as `"hello"` from serialized JSON text. Omitting the fact retains the existing custom-pool
contract. `adaptMySql2Pool(pool, "text")` supports a pool configured with `jsonStrings: true`.


`database.prepare(name, factory)` returns ordinary queries carrying instance-local prepared metadata. MySQL execution uses mysql2's binary `execute()` path and its per-connection prepared-statement cache. The factory caches its first structural SQL skeleton and rejects duplicate names or structural drift between calls. `preparedStatementLimit` bounds both the database's logical registrations and mysql2's per-connection LRU; it defaults to 16,000. The runtime rejects a new logical name at the bound instead of evicting a factory that application code may still hold. `decoderPlanCacheCapacity` independently bounds compiled row-decoder metadata.

Homogeneous fragment lists may vary only in cardinality. `preparedCardinalityVariantLimit` bounds
their rendered per-factory LRU at 32 variants by default, independently of mysql2's native cache.

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

## Structured JSON expressions

Literal-key `JSON_OBJECT`, `JSON_ARRAY`, `JSON_ARRAYAGG`, and `JSON_OBJECTAGG`
retain nested JSON structure through derived tables and common table expressions.
JSON numbers decode as JavaScript numbers even when ordinary SQL bigint or decimal
columns use another type policy. Dates become JSON strings; SQL `NULL` used as a
constructor value becomes JSON `null`. Empty aggregate input returns SQL `NULL`.

Literal paths in `JSON_EXTRACT` and static mutations (`JSON_SET`, `JSON_INSERT`,
`JSON_REPLACE`, `JSON_REMOVE`, `JSON_ARRAY_APPEND`, `JSON_ARRAY_INSERT`,
`JSON_MERGE_PATCH`, and `JSON_MERGE_PRESERVE`) retain supported structural evidence.
MySQL array path legs wrap a non-array value as a one-element array. Missing
multi-path matches are omitted. Dynamic paths, wildcard paths, and unsupported
values remain conservative. `JSON_UNQUOTE` returns SQL text, including the text
`'null'` for a JSON null value.

The `json: 'string'` type policy keeps JSON results serialized. An encoded JSON
parameter remains SQL text in constructor value positions; use an explicit
`CAST(... AS JSON)` when MySQL must embed a JSON document instead of a string.
Application JSON declarations contribute narrower types only when analysis has a
runtime validation contract; ordinary analysis does not trust those declarations.

Introspection recognizes an enforced `CHECK (JSON_SCHEMA_VALID('literal schema',
json_column))` as database evidence for the supported structural JSON Schema
subset. Unenforced checks, compound predicates, dynamic schemas, and unsupported
schema compositions do not narrow the column.

JSON column parameters retain their declared shape even with `json: 'string'`.
Use `sql.json(value)` in tagged queries or `jsonValue(value)` in positional query
factories to pass an explicit JSON document. JSON document arguments such as the
first argument of `JSON_EXTRACT` accept these bindings; constructor VALUE arguments
keep their ordinary SQL value behavior. Use `CAST(... AS JSON)` to embed an encoded
document inside a constructor.
