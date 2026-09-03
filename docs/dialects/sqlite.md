---
title: SQLite
description: SQLite dynamic typing, STRICT tables, catalog introspection, and the optional node:sqlite adapter.
---

# SQLite

`@typed-sql/sqlite` is the stable SQLite grammar. It keeps SQLite's dynamic type system honest,
introspects real database files or in-memory databases, and exposes the built-in Node client only
through `@typed-sql/sqlite/node-sqlite`.

## Public entrypoints

- `@typed-sql/sqlite` — `sql`, dialect factory, snapshot types, type policy, and introspection over an injected queryable.
- `@typed-sql/sqlite/runtime` — driver-neutral rendering and executable adapter contracts.
- `@typed-sql/sqlite/node-sqlite` — lazy `node:sqlite` loading, schema provider, and executable database adapter.

The package has no dependency, optional dependency, or peer dependency on an SQLite driver.
`node:sqlite` is part of Node itself. The adapter supports Node 22 from 22.13 onward, Node 24, and
Node 26. Odd-numbered and unlisted future Node lines fail closed until they enter the tested matrix.

## Supported versions

The complete language baseline is SQLite 3.39.0 through 3.53.4. The 3.39 floor is intentional: it
is the first release with RIGHT and FULL OUTER JOIN, completing the query-structure baseline. The
upper bound is the latest release verified by this repository, not a prediction that later SQLite
versions are incompatible. Older libraries can still resolve individually version-gated features,
but remain conservative as a complete target; unrecognized newer and prerelease libraries also stay
conservative until their differential matrix passes. The actual library version and compile options
come from the connection rather than the operating system or Node version label.

The grammar package works on the repository's general Node range. The explicit
`@typed-sql/sqlite/node-sqlite` adapter uses the narrower Node 22.13+, 24, and 26 matrix and remains
synchronous. It does not claim cancellation merely because the common database contract supports
cancellation.

| Evidence dimension | Stable contract | Verification |
| --- | --- | --- |
| SQLite language | 3.39.0–3.53.4 | Source-built 3.39.0 and 3.53.4 plus every supported Node line's bundled library |
| Newer SQLite | Conservative until reviewed | Non-blocking source-built 3.54.0 canary |
| Node grammar use | Node 22.11 or newer | Repository-wide Node checks |
| `node:sqlite` adapter | Node 22 from 22.13 onward, Node 24, and Node 26 | Minimum and current releases from each listed line |
| Compile-option features | Exact only when recorded evidence enables them | Differential probes retain the normalized compile-option list |
| Optional/application extensions | Exact only when catalog or application declarations establish them | Provider snapshot and grammar fixtures |

Compile and extension evidence is interpreted independently from the language version:

| Feature family | Required evidence |
| --- | --- |
| JSON text functions | Supported version and no recorded `OMIT_JSON` |
| JSONB | JSON availability and SQLite 3.45 or newer |
| Math functions | `ENABLE_MATH_FUNCTIONS` |
| Percentile functions | SQLite 3.51 or newer and `ENABLE_PERCENTILE` |
| `SOUNDEX`, `sqlite_offset`, and `carray` | Their corresponding recorded compile option |
| Application routines | Matching explicit routine declaration in the provider registry |
| Other loadable extensions | Application declaration where supported; otherwise conservative |

## Dynamic typing and STRICT tables

SQLite associates a storage class with each value, not with its containing column. A declared type
on an ordinary table supplies affinity but does not prevent values of other storage classes. The
default policy therefore maps a non-STRICT column to the sound storage union:

```ts
bigint | number | string | Uint8Array | null
```

`null` is omitted when the catalog proves `NOT NULL`. This is deliberately wider than the column's
declared affinity. Set `flexible: "unknown"` to make ordinary-table values fully opaque.

STRICT tables enforce the SQLite type names `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, and `ANY`.
Those columns receive precise types, except `ANY`, which retains the flexible union. The default
integer policy uses `bigint`; the Node adapter calls `setReadBigInts(true)` on every prepared
statement so runtime values match inference.

## Introspection

The provider uses `PRAGMA table_list`, `table_xinfo`, `index_list`, `index_xinfo`, and
`foreign_key_list`. Snapshots preserve:

- tables, views, virtual tables, and attached schema names;
- virtual-table modules, shadow tables, and hidden virtual-table columns;
- STRICT and `WITHOUT ROWID` flags;
- normal, generated, hidden, and rowid-alias columns;
- defaults, SQLite-primary-key nullability, generated-expression fingerprints, and primary-key position;
- unique, partial, expression, and primary-key indexes, including collations and per-expression fingerprints;
- grouped composite foreign keys;
- individual check-predicate fingerprints and opaque trigger identities;
- explicitly configured application scalar, aggregate, and window routines;
- the SQLite library version, sorted compile options, and portable attached-database identities used by
  versioned capability and drift resolution.

Application-defined routines must be supplied with their kind, argument types, result type,
nullability, and optional determinism/null-input contract. SQLite's catalog cannot prove those
TypeScript contracts by itself. Pass the registry to `nodeSqlite()` or `SqliteSchemaProvider`:

```ts
const provider = nodeSqlite({
  path: "app.db",
  routines: {
    "application.normalized_email/1": {
      name: "normalized_email",
      kind: "scalar",
      arguments: [{ databaseType: "TEXT" }],
      result: { databaseType: "TEXT", tsType: "string", nullable: false },
      deterministic: true,
      nullInput: "strict",
    },
  },
});
```

The registry is schema evidence only; the application or selected driver must still install the
implementation on each connection. With `node:sqlite`, call the native connection's function or
aggregate registration API before introspection and pass the matching declarations to the provider.
The deprecated `functions` option remains a scalar-only bridge.

Collations and virtual-table modules follow the same ownership rule, but their availability is
established differently. Install a collation before creating or introspecting objects that name it;
the provider records the collation on columns and index terms. Install or compile a virtual-table
module before `CREATE VIRTUAL TABLE`; introspection records the module name, hidden columns, and
shadow tables. The built-in Node API does not expose arbitrary collation or virtual-table module
registration, so applications that need those registration hooks use an application-owned SQLite
driver adapted through `@typed-sql/sqlite/runtime`. typed-sql never assumes that an unrecorded
extension exists.

Custom logical codecs also live at the application adapter boundary. The stable `node:sqlite`
adapter accepts and returns only SQLite storage classes; it deliberately does not reinterpret JSON,
dates, or declared affinity as application objects. Encode parameters before interpolation and
decode rows after execution, optionally attaching a Standard Schema result validator. If a custom
codec is not represented by grammar-owned snapshot/type-policy evidence, static inference remains
the storage-class union or `unknown`; registering a runtime converter alone cannot narrow it.

```ts
const encoded = JSON.stringify({ theme: "dark" });
await database.execute(sql`UPDATE account SET preferences = ${encoded} WHERE id = ${accountId}`);

const [stored] = await database.execute(sql`
  SELECT preferences FROM account WHERE id = ${accountId}
`);
const preferences = JSON.parse(String(stored?.preferences)) as unknown;
```
An exact `INTEGER PRIMARY KEY` rowid alias is non-null `bigint` by default and is not a required
insert column because SQLite can allocate it. Ordinary primary-key columns in non-STRICT rowid
tables remain nullable when the catalog says they are nullable; `WITHOUT ROWID` and STRICT primary
keys do not inherit that historical SQLite exception. Implicit `rowid`, `_rowid_`, and `oid` names
resolve only for ordinary rowid tables and disappear when a declared column shadows that spelling.

## SQL coverage

The grammar supports SELECTs, aliases, inner and outer joins, ordinary and recursive CTEs,
derived and correlated subqueries, grouping, windows, aggregate `FILTER`, CASE expressions, casts,
JSON operators, compound `UNION`/`INTERSECT`/`EXCEPT` queries, ordered parameters, and
`INSERT`/`UPDATE`/`DELETE RETURNING`.

Version gates follow the embedded library recorded in the snapshot: aggregate `FILTER` requires
3.30, `RETURNING` requires 3.35, STRICT tables require 3.37, and `FULL JOIN` requires 3.39. Known-old
features fail with a source diagnostic, while missing or unparseable evidence remains conservative.
Compile options such as `OMIT_WINDOWFUNC` can disable otherwise version-available syntax.

Core scalar, aggregate, and window functions are selected from reviewed SQLite-owned catalog data,
not from resolver branches. The same catalog records arity, result type, nullability, function kind,
and release boundaries. In the supported band this includes `unhex` from 3.41, `octet_length` from
3.43, `concat`, `concat_ws`, and `string_agg` from 3.44, the 3.48 and 3.49 `iif`/`if` arity changes,
and `unistr`/`unistr_quote` from 3.50. A gated call without normalized server evidence produces a
conservative diagnostic; a call against a known older library reports the unmet release boundary.
JSON text and JSONB scalar and aggregate functions, `->`/`->>` operators, and JSON table functions
are versioned separately. JSON is available in the supported band only when recorded compile options
do not contain `OMIT_JSON`; JSONB requires SQLite 3.45, `json_pretty` requires 3.46,
`jsonb_each`/`jsonb_tree` require 3.51, and `json_array_insert`/`jsonb_array_insert` require 3.53.
The table functions expose their documented visible columns while keeping `json` and `root` hidden
from `SELECT *`.

Date/time functions preserve their text, real, and integer result classes. `unixepoch(..., 'subsec')`
returns `number`, ordinary `unixepoch` returns the configured integer type, `timediff` requires 3.43,
and newer literal modifiers and `strftime` substitutions are checked against their release boundary.
`CURRENT_DATE`, `CURRENT_TIME`, and `CURRENT_TIMESTAMP` resolve as non-null text.

Math functions require recorded `ENABLE_MATH_FUNCTIONS` evidence. `SOUNDEX`, `sqlite_offset`, the
3.51 percentile family, and the `carray` table function likewise require their own compile options. A
`carray` input remains `unknown` because binding it requires SQLite's dedicated C interface rather
than an ordinary SQL value. Missing compile evidence is
conservative; recorded evidence that omits or disables the family produces `TSQ406`. `load_extension`
is connection state and resolves only when the application routine registry declares it.

Binary operator result classes and SQLite numeric compatibility are also grammar-owned catalog
data. Ordinary arithmetic is inferred only when both operands have numeric database-type evidence;
otherwise analysis returns `unknown` with a diagnostic instead of applying JavaScript coercion.

Window analysis covers named and inline windows, chaining, `ROWS`/`RANGE`/`GROUPS` frames, all frame
bounds and exclusions, and the nullability of SQLite's built-in ranking, offset, and value functions.
Invalid chaining, frame offsets, modifiers, arities, and placements fail with stable diagnostics.

Writes support SQLite's five `OR` conflict algorithms, `REPLACE`, chained `ON CONFLICT` clauses,
conflict targets, the typed `excluded` relation, conditional `DO UPDATE`, and `DO NOTHING`.
`RETURNING` is target-only and rejects top-level aggregates and windows. `UPDATE FROM` keeps target
and source relations distinct and diagnoses ambiguous columns.

Recursive CTEs follow SQLite's seed-first compound rules, including its single top-level self-reference
and aggregate/window restrictions. SQLite also permits recursion without spelling `RECURSIVE`.
PostgreSQL-only `SEARCH`/`CYCLE`, `ROWS FROM`/`WITH ORDINALITY`, `TABLESAMPLE`, `DISTINCT ON`, array
constructors, and SELECT locking clauses fail closed. SQLite's own cataloged and application-defined
table functions remain supported. Unknown functions infer `unknown` unless configured in the snapshot.

## Runtime behavior

The Node adapter supports Node.js 22.13+, 24, and 26 independently of the SQLite language-version
range. It reads `sqlite_version()` and `PRAGMA compile_options` whenever it opens a connection.
Pass the generated schema as `snapshot` to `createNodeSqliteDatabase()` to fail before execution
when the connection's SQLite version, compile options, or generated type-policy hash differ from
the compiler evidence.

The adapter keeps a bounded LRU of native prepared statements and invalidates that cache after SQL
that changes schema or connection capabilities. If application code mutates a separately adapted
native connection directly, create a fresh adapter after that mutation. `database.prepare()` also
freezes the typed-sql structural shape, so later factory calls may change values but not SQL
structure. `batch()` executes queries sequentially on the same connection. Use an explicit
transaction when the batch must be atomic.
Homogeneous fragment lists may vary only in cardinality; `preparedCardinalityVariantLimit` bounds
their rendered per-factory LRU at 32 variants by default, separately from the native statement LRU.

Runtime values follow the same SQLite storage policy used during inference. Integers decode as
`bigint` by default or as `number` under the number policy; boolean parameters encode as `1` or `0`
in that integer representation. Text, real, blob, and null values remain `string`, `number`,
`Uint8Array`, and `null`. SQLite JSON text therefore remains a string and JSONB remains a blob;
parse or serialize application JSON explicitly instead of relying on an untyped object conversion.

Transactions use `BEGIN` at the root and savepoints when nested. A root operation queue keeps
ordinary calls from accidentally entering an active transaction. Streams wrap the native
synchronous iterator in the common async iterator contract and hold exclusive connection ownership
until exhaustion or `close()`. The adapter uses the native iterator when the selected host exposes
it and retains a buffered `all()` fallback for driver-neutral adapted connections. `batchSize` is
validated for API portability but does not create server-side pages in an embedded database.

`node:sqlite` is synchronous and can block the Node event loop during database work. The adapter
does not claim cancellation or deadline support. For write-heavy or latency-isolated services,
choose an adapter backed by the worker or process model owned by your application.

SQLite is on the stable release track. Its compiler, CLI, generated snapshot format, and grammar
conformance contract are the same stable boundaries used by the PostgreSQL and MySQL packages.
