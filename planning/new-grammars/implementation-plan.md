# SQL Server and DuckDB implementation plan

Internal engineering plan for #253 and #254. Research date: 2026-11-05.
Status: cross-reviewed and ready for staged implementation. The review record below resolves
planning objections. Native transport and complete product qualification are implementation gates,
not public support claims established by this plan.

## Outcome

Deliver `@typed-sql/sqlserver` and `@typed-sql/duckdb` as first-class, independently owned grammars.
Applications import `sql` from their chosen grammar root, install drivers explicitly and compile
queries against canonical snapshots. Both packages receive the inference, runtime, distribution,
editor, documentation and live compatibility evidence expected of PostgreSQL and MySQL today.
A conservative or unsupported classification is legitimate when the language or driver cannot prove
a contract; using that classification to omit the issue's explicit type families or ordinary query
surface is not a substitute for implementation.

This plan is implemented as reviewable MRs. The goal is not complete after the planning MR or an
initial scaffold. No new package is described as qualified/stable until its entire maturity matrix
passes. Existing PostgreSQL, MySQL and SQLite behavior remains a regression gate throughout.

Companion evidence and detailed design:

- [Maturity requirements and baseline](./maturity-audit.md)
- [Shared contracts and neutral changes](./shared-architecture.md)
- [SQL Server study](./sqlserver-research.md)
- [DuckDB study](./duckdb-research.md)

## Package and ownership decisions

| Concern | Neutral owner | Grammar/adapter owner |
|---|---|---|
| Source ranges, bounded cursors, configurable lexical primitives | `@typed-sql/ast` toolkit | Keywords, syntax, AST, precedence and parser diagnostics |
| Query/fragment mechanics and ordered values | `@typed-sql/core` | Placeholder spelling, quoting, limits and syntactic parameter classification |
| Logical nested JavaScript validation | Core recursive value descriptors | Native type parsing, coercions, physical binding and driver wrapper conversion |
| Snapshot envelope and canonical serialization | `@typed-sql/schema` format v2 | Catalog queries, type identities, settings, naming and extension evidence |
| SQL-file/inline transforms, artifact mechanics | Compiler/build | Analysis, output shape and proof of repeated-fragment stability |
| Standard execution contracts | Core | Connection leases, native statements/results, transactions, streams and controls |
| Public feature/evidence contracts | Conformance | Grammar-specific fixtures, version gates and real-engine runners |
| CLI/editor orchestration | Existing integrations | Registry entry, browser-safe grammar module, examples and diagnostics |

No core switch on `sqlserver` or `duckdb`, no dependency on a driver from a grammar root, no reuse of
another grammar's private parser, no arbitrary SQL rewriting in a neutral package, and no shared
schema-format bump without a demonstrated missing representation.

## Version and target policy

Versions are checked against the current vendor calendar and npm metadata, not memorized defaults.
The package's grammar version, engine support policy and exact adapter qualification are distinct.
Unknown newer engines, prereleases, settings, installed types and extensions remain conservative.

### SQL Server

Research targets are SQL Server 2017/2019/2022/2025, engine major 14/15/16/17 and database compatibility
levels 140/150/160/170. The final qualification matrix must separate product identity, four-part
build, compatibility level, edition/platform and relevant SET/collation settings. Azure SQL Database,
Managed Instance, Synapse and SQL Edge are separate products; they do not inherit SQL Server support.
Qualified engine/compatibility combinations are explicitly triangular: 2017 at 140; 2019 at
140/150; 2022 at 140/150/160; 2025 at 140/150/160/170. Impossible higher compatibility levels do
not inherit support. Historical lower levels are conservative/negative unless separately qualified.
Versions before the chosen floor diagnose as unsupported rather than being compared as generic
semver. The current 2025 target is CU10 (17.0.5035.5); exact image tags and immutable digests are in
the SQL Server study and must be rechecked when the CI matrix is committed.

Use actual x86-64 Linux CI for server evidence. Microsoft does not qualify these containers under
Apple-arm64 emulation. Local parser/runtime unit work may proceed on arm64, but emulator results do
not satisfy real-server qualification. Pin an official ODBC driver and native SDK in the exact
transport matrix; credentials are generated for disposable CI containers and never enter artifacts.

### DuckDB

Current release is DuckDB 2.0.0 LTS with Neo `@duckdb/node-api` 2.0.0-r.1. Qualify engines
**1.5.6 and 2.0.0** with SDKs **1.5.6-r.2 and 2.0.0-r.1**, respectively. These are explicit
initial version windows: 1.5.6–1.5.6 and 2.0.0–2.0.0, not a continuous interval. Unqualified
patches/minors remain conservative until tested. DuckDB 1.4.5 reaches upstream EOL on 2026-11-17,
and its SDK lacks required lifecycle APIs; classify it as unsupported for this initial integration.
There are no existing typed-sql DuckDB consumers whose support is being removed. Do not lower the
floor without real-engine and SDK lifecycle qualification.

SDK capabilities are separate from grammar versions: the probed 1.5.6-r.2 and 2.0.0-r.1 expose
prepared result metadata and explicit result closure; older bindings differ. Native 2.0 unread streams can block a connection
until closed. Each supported SDK line needs its own lifecycle/capability proof. Native Neo is the
initial execution path. DuckDB Wasm, Quack Remote, MotherDuck and extensions require separate
qualification and are not implicitly covered by a Node adapter.

Authoritative primary references checked during research:

- https://duckdb.org/release_calendar
- https://github.com/duckdb/duckdb-node-neo/releases
- https://learn.microsoft.com/en-us/sql/linux/install-upgrade/setup
- https://github.com/TimelordUK/node-sqlserver-v8/releases/tag/v6.1.0

## Shared changes justified by concrete requirements

### N1: native structural values and physical target evidence

Extend `RuntimeValueType` with required plain-object fields and positional tuples. Each child carries
its own `{ type, nullable }`. Add optional exact `length` to array descriptors. Existing literal and
union descriptors express a tagged native union; an ordered array of key/value tuples expresses a
MAP without stringifying arbitrary keys. This keeps SQL-specific types out of core.

Add optional bounded opaque `databaseType` to executable value descriptors and preserve grammar
analysis metadata in `buildQueryValuePlan`. A full native DuckDB type expression describes nested
bind types, including typed NULL/empty values. SQL Server precision/scale/temporal targets similarly
need the canonical native type, not just a logical `string` or `bigint`.

Core stores and validates metadata only. Grammar code must parse/allowlist native type syntax before
using it in an SDK call or a generated CONVERT expression. An opaque metadata string is not trusted
SQL. There is no serialized executable callback or global codec registry.

Required consumers: immutable plan normalization, recursive bigint and JSON ambiguity checks,
parameter/result encoding and decoding, parameter type generation, selectors/repeated variants,
artifact compatibility and fingerprints. Preserve existing SQL-file comparisons of databaseType,
runtimeType and JSON descriptors; strengthen ParameterCollector's repeated evidence where it
currently compares only TS/JSON text. An incompatible physical target cannot inherit the first
occurrence's codec accidentally.

Budgets apply to all new descriptors and fields: depth, total nodes, tuple/field counts, lengths,
keys and metadata text. Read descriptor own data properties without invoking getters; reject cycles,
accessor-bearing or unexpected prototypes. SQL field names such as `__proto__` must not mutate a
prototype or disappear: either safely preserve them with own-property construction or diagnose the
specific unsupported shape. Never drop them while reporting an exact type. Decode nested containers
into owned values; distinguish SQL NULL containers from nullable fields/elements/tag payloads.

### N2: lexical primitives only when needed

The toolkit already handles bracket identifier quoting, prefixed strings and nested block comments.
Its parameter modes currently lack named `@name` and `$name`; identifier characters are fixed.
If the new parsers use the toolkit, add small declarative profile modes and marker precedence, not
vendor syntax. SQL Server `@@system`, `@locals`, `#temp` and parameter names are distinguished by its
parser/binding rules. DuckDB dollar-quoted strings, named versus indexed markers, struct/map braces,
numeric separators and lambda operators need real-engine-backed lexical fixtures.

Full parsing stays in each package. No use of `ast/compat` or another package's private parser.
AST changes must preserve UTF-16 source reconstruction and allocation/performance budgets.

## SQL Server grammar, types and runtime

The package owns SELECT projections/aliases, quoted and multipart names, joins and APPLY, CTEs and
recursive CTEs, TOP/PERCENT/WITH TIES, ORDER BY/OFFSET/FETCH, grouping/windows and set operations.
It owns INSERT/UPDATE/DELETE and OUTPUT with inserted/deleted scopes and target restrictions.
Parameters are occurrence-ordered and named SQL files reuse logical arguments without losing
physical type evidence. Enforce the engine's parameter ceiling in its grammar/adapter.

Type/coercion rules include integer promotion and overflow, SUM/AVG results, DECIMAL precision/scale,
MONEY/SMALLMONEY, BIT predicates, NVARCHAR/VARCHAR and collation-sensitive comparison, binary and
rowversion, UNIQUEIDENTIFIER, date/time/datetime/datetime2/datetimeoffset, XML, JSON functions and
version-specific native JSON. Never treat `timestamp` as a date: it is rowversion binary. SQL_VARIANT,
CLR/spatial/hierarchyid/unknown aliases require an explicit proven codec or unknown/diagnostic.
User-defined scalar/table routines need catalog result evidence, not name-based guesses.

Snapshot v2 preserves schemas/catalog/database identity, default schema, types and aliases,
column order/nullability/identity/computed columns, constraints/indexes and routine shapes, server
build/compatibility, collation and material session settings. Incomplete catalog permissions must be
reported. SQL names follow SQL Server's catalog collation rules; generic lowercase lookup is not an
acceptable universal substitute. Temp/dynamic/cross-database/linked-server relations require explicit
evidence and session affinity, otherwise fail closed.

Exact transport design is a critical dependency, not deferred polish:

- Direct `msnodesqlv8` >=6.2.2 exposes exact numeric-string output. The `mssql/msnodesqlv8` wrapper
  converts these strings back to numbers and cannot serve as the exact path.
- A default exact decimal policy must preserve numeric text/coefficient precision; never call
  `String` on a value that a driver already rounded.
- Decimal and high-precision temporal inputs require bound text plus grammar-owned, validated native
  target conversion at parameter occurrences where public driver native bind helpers lose precision.
  Use a grammar-owned per-plan renderer: `placeholder(index)` renders a validated CONVERT around
  that bound value segment. Existing render mechanics already locate value segments; do not scan
  or replace SQL text. Lowering is valid only at grammar-proven scalar expression sites; identifiers,
  types, hint/collation names, procedural output arguments and batch controls cannot use this path.
  ODBC physical markers can be `?` while the portable grammar uses its named
  markers. Native target and policy belong in the prepared/render cache identity.
  Prove this on SELECT, DML/OUTPUT, repeated names and prepared queries without changing DISTINCT,
  ORDER BY or output projection semantics. Reject injected metadata, unrecognized targets and
  unsupported conversion contexts before dispatch.
- Temporal policy may deliberately normalize datetimeoffset to a canonical UTC instant, preserving
  100ns precision, rather than promising the original source offset. Prove SDK nanosecond-delta
  handling, UTC mode, year boundaries, negative epochs, scales and input round trips.
- A separate `mssql`/Tedious compatibility adapter can expose only its demonstrated policies and must
  reject incompatible exact plans before dispatch; it cannot inherit the exact ODBC claims.

Expose ownership-aware buffered/prepared/transaction/atomic-batch/stream APIs and cancellation only
when cleanup is demonstrated. Requests and pending operations share a lease; escaped scopes and
unawaited failures cannot commit. Abort/timeout races, connection close, transaction rollback failure
and failed prepare must release or quarantine correctly. Multiple result sets/procedural batches
cannot be silently reduced to the first row set. Native TVP/bulk/plan/describe services remain explicit
capabilities with specific tests; irrelevant PostgreSQL-only capabilities are not copied.

## DuckDB grammar, types and runtime

The package owns SELECT expressions and scalar/subquery inference, joins including analytical joins,
CTEs, set operations, grouping/aggregates/windows, QUALIFY, UNNEST and deterministic output shapes.
Include LIST/ARRAY constructors and indexing, STRUCT/TUPLE construction and field access, MAP and
tagged UNION functions, casts and lambda forms whose semantics can be proven. INSERT/UPDATE/DELETE,
RETURNING and fixed-output analytical statements receive DML/result semantics; unsupported shapes
must diagnose, not parse only the prefix. A fixed PIVOT can have explicit output evidence; dynamic
PIVOT/COLUMNS/external files/schema-changing extensions cannot fabricate columns.

Policies and codecs cover signed/unsigned integers through HUGEINT/UHUGEINT and BIGNUM, exact
DECIMAL width/scale, BOOLEAN, blobs/UUID/ENUM/BIT, date/time/timestamp precision and timezone/infinity,
calendar INTERVAL, JSON versus SQL NULL and native nested values. LIST elements can be NULL; ARRAY
length is exact; STRUCT field nullability is independent; unnamed TUPLE fields cannot disappear;
MAP keys preserve native value identity; UNION tag and NULL member payload differ from a SQL NULL
UNION. No native structure is routed through JSON.stringify, which loses bigint/type distinctions.
The current SDK's partial VARIANT construction/binding limitations receive explicit capability gates.

The provider records catalogs/attached databases/schemas/search path, structural logical types,
relations/constraints/indexes/macros/routines as available, version, extensions and semantic settings.
Runtime validates/establishes matching timezone/casting/search-path settings. Driver metadata can be
an independent differential oracle but cannot replace static grammar analysis by executing a query.

Use native statement extraction to reject multiple statements before any execute call; Neo `run`
otherwise executes all statements and returns only the last result. Bind explicit native logical
types for NULL, empty LIST/ARRAY/MAP/STRUCT and DECIMAL. Normalize SDK wrappers with actual type
metadata; do not turn arbitrary MAP keys into object strings or erase a tagged NULL payload.
Destroy prepared statements and close all results, including early-abandoned streams and in-flight
fetches. Connection interruption must be scoped to the operation lease and drained before reuse.
Transactions/batches/instance ownership/file locks must have failure and reopen tests. Native appender
bulk capability and nonexecuting prepare/EXPLAIN metadata use the existing neutral capability APIs.

## Product integration and maturity acceptance

New packages get root/`query`/`runtime` and explicit driver entrypoints, version exports, diagnostics,
capability evidence and snapshot APIs. Stable dependencies must never reach preview packages.
Update the CLI registry and initialization guidance, project references, public API/package graph,
forbidden driver list, release manifest/Changesets and packed consumer installation tests.

Both grammars work through inline and SQL-file compilation, generated declarations, named/repeated/
reordered parameters, ordinary values versus structural fragments, conditional/repeated lists,
scalar brands and artifact identities. Extend conformance through lex/parse/resolve/compile/render/
prepare/execute/plan with exact UTF-16 ranges and parameter tuples, explicit skips only for genuinely
unavailable capabilities. Add catalog/coercion/nullability/soundness and hostile-input tests.

CLI, build integrations, real packaged language-server/editor fixtures and browser playground all
use the same grammar. Add browser-safe schema samples and version/settings controls; do not load
native SDKs or Node modules into the browser. Test hovers/errors/completion/SQL-file queries for new
nested/native types and source ranges. Update canonical quickstart/dialect/type-policy/adapter/
example/compatibility docs and navigation plus concise README matrices. Public docs contain only
current behavior and tested support, never this roadmap.

Qualification combines representative required PR gates and the complete pinned matrix. Artifact
JSON records actual engine/SDK/runtime/architecture/product/settings/capabilities and feature probe
results. Keep native platforms separate. Public supported-version claims require those matrix rows
to pass, including settings and negative future-version cases. Packed tests use actual npm tarballs,
no workspace source symlinks. Existing PG/MySQL/SQLite suites, coverage thresholds, browser graph,
forbidden-driver contracts and performance budgets remain green.

## MR sequence and validation

| MR | Deliverable | Dependencies | Required evidence |
|---|---|---|---|
| P0 | Reviewed internal studies, exact decisions, qualification design | None | Independent dialect/shared reviews, vendor sources, real SDK probes |
| R0 | Exact SQL Server transport qualification on pinned native x86-64 CI | P0 | Published direct ODBC driver, numeric/temporal inputs/results and real settings proof |
| N1 | Nested logical descriptors + native target metadata | P0 | Hostile-input/budget/NULL/precision tests, compiler/selector/pack and old-grammar regressions |
| N2 | Proven neutral lexical profile additions, if used | P0 | Public synthetic grammar, lexical/source-span/fuzz/performance regressions |
| S1 | SQL Server grammar/provider/policies/catalog/codecs and static inference | R0, N1/N2 as needed | Full representative query+DML/OUTPUT conformance, version/settings and snapshot tests |
| D1 | DuckDB grammar/provider/policies/catalog/codecs and static inference | N1/N2 as needed | Nested/analytical query+DML conformance, version/settings and snapshot tests |
| S2 | Exact ODBC runtime; separately honest mssql compatibility path | S1 | Pinned x86-64 server precision/lifecycle/controls/prepared/stream/transaction tests |
| D2 | Native Neo runtime and capabilities | D1 | Real native engine matrix, typed NULL/nested/precision/error/file-lock/stream tests |
| S3/D3 | CLI/build/packed/editor/playground/docs/release integration | S2/D2 | Actual packed apps, browser grammar bundles, editor artifacts and canonical doc checks |
| Q | Cross-reviewed full maturity qualification | All | pnpm verify, soundness, pack, coverage, performance and complete live matrices |

Split S1/D1 or S2/D2 into smaller reviewable MRs when their size demands it. Do not label a lower
layer fully mature before its dependent runtime/integration/qualification work passes. Package work
can proceed in parallel in isolated worktrees after shared contracts are agreed; each MR owns named
paths to avoid conflicting changes. Root coordinates integration contracts and final cross-review.

## Review record and implementation readiness

Independent reviews are recorded in [SQL Server review](./review-sqlserver.md),
[DuckDB review](./review-duckdb.md) and [shared architecture review](./review-shared.md).
Root cross-checked the current repository contracts, official release/package metadata and an
independent native DuckDB 2.0 probe, then incorporated the blocking dispositions:

| Objection | Final disposition |
|---|---|
| Ambiguous DuckDB support floor/continuous range | Exact disjoint 1.5.6 and 2.0.0 windows and SDK pairs; 1.4.5 unsupported; future versions conservative |
| Impossible SQL Server engine/compatibility combinations | Explicit triangular 2017/140 through 2025/140,150,160,170 matrix |
| Exact SQL transport inferred from upstream code alone | R0 native x86-64 qualification before SQL Server policy acceptance, with permanent E2E probes |
| Broad SQL rewrite could change query semantics | Existing structural value renderer; grammar-validated scalar contexts and parsed native targets only |
| Typed target changes could reuse wrong prepared/render cache | Full immutable native plan/policy/lowering identity and negative cache-reuse tests |
| Native values mislabeled JSON or fields silently lost | Required own object fields, positional tuples, fixed lengths, ordered MAP entry tuples and tagged NULL unions |
| Metadata could inject SQL | Bounded data-only carrier; grammar parser/allowlist before native casts; negative injection fixtures |
| New descriptors silently dropped by old runtime | New package minimum shared-core version and missing-required-target rejection; packed old/new compatibility proof |
| Reviewable scaffolds mistaken for mature packages | Final Q acceptance remains the entire matrix, not completion of P0/N1 or package foundations |

The plan is ready to build. Open evidence requirements remain explicit in R0/S2/D2/Q. If a native
probe contradicts an intended policy, update the codec/driver design and re-review it; do not weaken
the goal or publish a false exact claim. Root coordinates MR dependencies and integration, while
agents implement disjoint owned paths and cross-review each other's final changes.
