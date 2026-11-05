# Shared architecture audit for SQL Server and DuckDB

Internal engineering plan, inspected against repository `main` after SQLite PRs #259–#261.
This is implementation planning, not a public compatibility claim. Dialect versions and driver
qualification belong to the companion SQL Server/DuckDB studies and their live evidence.

## Baseline and decision

The current neutral contract is substantially capable already. Adding a grammar does not require
teaching core about SQL Server, DuckDB, TOP, OUTPUT, QUALIFY, LIST or T-SQL coercion. The new packages
must own their tokenizer/parser/AST/resolver, built-ins, type policy, snapshot validation, runtime
codecs, semantics, catalog queries, version/settings gates and diagnostics. They must not import the
PostgreSQL/MySQL parser or the deprecated AST compatibility parser.

The maturity baseline is not one SELECT probe. Existing PostgreSQL/MySQL packages have dialect-owned
parser and soundness suites; catalog-backed snapshots; explicit driver entrypoints; executable value
plans; prepared/buffered/stream/transaction/batch behavior; failures and cancellation cleanup;
optional capabilities; live prepare/describe and plan evidence; public conformance; packed consumers;
CLI/build/editor/playground support; compatibility docs, feature ledger and performance budgets.
Examples: `packages/postgres/test`, `packages/mysql/test`, `e2e/postgres/test`, `e2e/mysql/test`,
`test/contracts/{package-graph,packed-consumer,parser-ownership,feature-ledger,documentation}.test.ts`.
Backend features may differ; comparable maturity means equally strong policy and evidence, not
pretending SQL Server has PostgreSQL COPY or DuckDB has a connection pool.

## Contract inventory: what works without redesign

- `packages/core/src/types.ts`: `DialectPlugin` contract 4 accepts arbitrary grammar IDs,
  `placeholder(index)`, `quoteIdentifier`, grammar-owned `parameterOccurrences`, policy and snapshot
  validation, version-aware capabilities, analysis source ranges and portable runtime entrypoint.
  No finite dialect enum is present here. Compiler/build/config and language-server load the plugin.
- `packages/core/src/query.ts`: renderer methods are grammar-provided; bound values are ordered;
  fragments/identifier segments and repeated lists already have bounded expansion and stable plans.
  SQL Server's lower parameter ceiling belongs in its grammar/renderer/adapter, not the global
  65,535 safety ceiling.
- `packages/compiler/src/sql-file-analysis.ts`: grammar occurrence ranges preserve lexical order,
  repeated names and numeric binds. SQL files are normalized through the grammar placeholder method;
  contiguous numeric slots, named/positional mixing and argument compatibility fail closed. An
  `@name` or `$name` lexer does not require a different core Query API.
- `packages/schema/src/v2/model.ts`: generic server evidence, namespaces, scalar/enum/domain,
  composite/collection/opaque types, relations, constraints/indexes and routines exist. Grammar-owned
  versioned JSON-safe extensions preserve facts the common model does not understand.
- `packages/core/src/dialect-capabilities.ts`: server product/version/versionKey/features/settings and
  version/feature/setting/policy/grammar evidence already model compatibility levels, collations,
  compatibility levels, installed extensions and session settings without dialect switches.
- `packages/schema/src/generator.ts`: canonical v2 envelope serialization/hash/drift includes
  namespaces/types/relations/routines/server/extensions and type-policy hash. No new general hash
  scheme is justified for these packages.
- `packages/core/src/execution.ts`, `adapter-capabilities.ts`: standard cardinality/batch/transaction,
  scoped services, streams and honest cancellation/deadline capability checks are sufficient.
  Engine-specific bulk/TVP/appender/multi-result interfaces can be namespaced capabilities.
- `packages/conformance/src/v2`: target capabilities, expected diagnostics and exact ranges,
  per-layer resolve/compile/render/prepare/execute/plan results, explicit skips, environment evidence,
  mutation policy and engine error classification are already neutral.

## Concrete shared changes

### 1. Bounded recursive native logical values

`packages/core/src/query-value-plan.ts:RuntimeValueType` only models scalar, JSON, literal, array and
union values. Native DuckDB STRUCT/MAP/fixed ARRAY/tagged UNION/INTERVAL are not JSON: they contain
bigint/bytes and distinguish outer SQL NULL, nested NULL and tagged inactive alternatives. Treating
all those as JSON or `unknown` does not satisfy the requested mature integration.

Add only general logical JS structures established by the DuckDB driver prototype:

- Required-field plain object descriptors with each field's own type and nullability.
- Positional tuple descriptors (including unnamed STRUCT and arbitrary typed MAP entry tuples).
- Optional exact array length on the existing array descriptor for fixed ARRAY.
- Existing `union` can represent tagged UNION as a union of required object shapes with literal tag
  and typed nullable value; there is no need for a hard-coded DuckDB UNION node in core.
- MAP defaults to an ordered readonly list of typed non-null-key/value tuples. It must not stringify
  arbitrary keys into object properties or silently lose ordering/duplicate distinctions. SQL/driver
  key restrictions and duplicate-key checks remain DuckDB codec semantics.
- INTERVAL can use a required object `{ months:number, days:number, micros:bigint }`; calendar semantics
  stay with the grammar. Decimal/temporal defaults can remain canonical exact strings, not new
  privileged Decimal/Temporal classes in core.

Touch all recursive consumers, not just the union declaration: `copyType`, `hasBigint`,
`ambiguousParsedJson`, `scalar`, result/parameter validation, plan selectors/compatibility and exports.
Descendant bigint transport rejection must happen before dispatch. Nested JSON ambiguity is still
checked. Error paths identify field/tuple/array locations.

Apply existing depth/node/count budgets to every new node, keys and total expansion. Reject cyclic
or accessor/custom-prototype-bearing descriptors; canonical deterministic copies must not invoke
user getters or leak prototypes. SQL names such as `__proto__` and `constructor` remain valid own
data keys: use safe `Object.defineProperty`/`Object.fromEntries` construction and never inherited
property lookup. Decode into fresh owned values, validate exact tuple length/array length/required
fields, reject malformed wrappers and non-finite/unsafe number leaves. Prototype properties never
count as required fields. Reject unexpected own fields rather than stripping or retaining unverified
values in a fixed native STRUCT; absent fields are errors even when the declared field is nullable. Do not mutate input or make SQL NULL acceptable
because a JavaScript union member happens to resemble an object.

Regression fixtures: nested nullable bigint STRUCT, MAP of bytes/list/struct, NULL MAP/STRUCT vs NULL
member, tagged UNION NULL payload, inactive/unknown tags, empty/fixed arrays, tuples, bounds, prototype
keys/cycles/depth exhaustion, nested safe-number transport rejection and copied decoded containers.
Re-run PostgreSQL array/JSON and MySQL transport suites to preserve previous behavior.

Proposed concrete neutral shape (names are provisional until API review):

```ts
export interface RuntimeValueField {
  readonly type: RuntimeValueType;
  readonly nullable: boolean;
}
// Add to existing RuntimeValueType union:
// | { readonly object: Readonly<Record<string, RuntimeValueField>> }
// | { readonly tuple: readonly RuntimeValueField[] }
// Extend existing array member with readonly length?: number.
```

Object fields are required own data properties; field absence is not SQL NULL. Tuple entries are
ordered, exact-length, with per-slot nullability. Array length is a non-negative safe integer within
existing descriptor expansion limits; each grammar further restricts native dimensions to its engine
(for example, it must not infer a valid native zero-length ARRAY merely because core can express it). Object/tuple descriptors need no SDK classes, SQL type names,
Map-specific opcode or arbitrary functions. Keep SDK normalization recursive and grammar-owned.

### 2. Preserve physical binding/codec identity in value plans

`ResolvedColumn` and `ResolvedParameter` expose `databaseType`, but
`packages/compiler/src/value-plan.ts:descriptor()` discards it. `QueryValueDescriptor` retains logical
type/nullability/JSON facts only. SQL Server explicit `request.input(name, nativeType, value)` and
DuckDB typed null/empty nested/DECIMAL binding require more than a JS string or array. A logical
string could mean VARCHAR, UUID, exact DECIMAL or a temporal target.

Start with an additive immutable bounded opaque `databaseType?: string` because both grammar
prototypes can recover their supported target precision/scale/native type tree from type text. Do
not add a codec registry or arbitrary encoder callback. A broader versioned grammar-owned JSON-safe
transport descriptor is deferred unless live evidence proves text insufficient. Core stores/validates/copies metadata; it does not parse SQL types or
load codecs/drivers. A bounded string is not SQL-safe: any adapter that lowers a physical target
into a CAST/CONVERT must reparse/allowlist it with its grammar before emitting SQL, never interpolate
arbitrary plan metadata as trusted raw type text. Grammar runtime reads its own descriptor to select explicit SDK binding and
wire decoding. Descriptors are data, never arbitrary serialized functions.

Keep `databaseType` on the top-level QueryValueDescriptor only: a grammar-parsed native type string
can describe all nested child targets without putting SQL metadata on RuntimeValueField. Bound each
metadata string and aggregate plan text as well as nodes, so 65,535 short descriptors cannot hide an
unbounded metadata allocation. Preserve fail-closed behavior when older runtimes encounter new
structural descriptors; no contract-version bump is needed merely to add value variants that old
`copyType` already rejects. Version emission/compatibility explicitly if a future format can be
misinterpreted by an older runtime.

Carry identity through compiler/build emission, SQL-file declarations/value plans, plan selectors,
prepared variants, runtime compatibility and artifacts. In `ParameterCollector` (`core/resolver.ts`),
merge comparisons currently ignore conflicting `runtimeType`; in SQL-file repeated-argument grouping,
note that repeated SQL-file arguments already compare `databaseType`, `runtimeType`, JSON and scalar
JSON identities. Preserve those existing comparisons and extend only for additional metadata.
Conflicting native targets that share a TS `string` or
`bigint` must either have a grammar-proven common input or diagnose/remain unknown, never inherit the
first occurrence's physical codec optimistically. Test repeated and reordered names, typed NULL,
empty nested values, DECIMAL(p,s) and two distinct policies with identical TS text.

This metadata does NOT solve a lossy driver. If a SQL Server driver has already rounded a DECIMAL to
number or truncated datetime2 to Date, converting it afterward to string is invalid. SQL Server must
prove a genuine exact wire path with a supported driver or grammar-owned semantics-preserving
lowering for every advertised form. Do not add a generic SELECT wrapper: ORDER BY/TOP/DISTINCT,
OUTPUT/DML and metadata boundaries make that unsound. No exact claim until real boundary cases pass.

### 3. Profile-driven lexical additions only if the grammar uses the toolkit

`packages/ast/src/toolkit/types.ts:SqlParameterMode` supports `?`, `?N` and `$N` only. Identifier words
are hard-coded to Unicode letters/underscore then letters/digits/underscore/dollar in `tokenizer.ts`.
Bracket quotes already work via open/close with double-close escaping; prefixed N/E strings and
nested comments are already profile options.

If both grammars use the toolkit, add bounded declarative named-marker modes (`@name`, `$name`, and
possibly `:name` already duplicated in grammar tokenizers) and declarative extra identifier-prefix
characters when proven necessary (`#temp`, `##temp`, `@@system` must remain distinguishable by the
owning grammar). Prefer marker-prefix/string/boundary configuration over callbacks or vendor enums.
Do not lex `@@ROWCOUNT` as a bind or treat `@local` declarations as SQL-file inputs accidentally.
DuckDB's parameter/dollar-string collisions need lexical precedence tests owned by DuckDB.

A grammar-owned tokenizer is already permitted. Do not expand toolkit just to centralize SQL
semantics. Never use `packages/ast/src/compat` as a new shared grammar base. Add UTF-16/astral/multiline,
comment/string/quoted-identifier, marker collision, malformed token, token/depth limit and allocation
benchmarks plus unchanged existing profile tests.

### 4. Catalog and name lookup: retain qualification and settings

Schema v2 RelationSnapshot currently has only `schema?: string`, while namespaces can have catalog,
database or schema kind. SQL Server and DuckDB need fully-qualified identities beyond two parts.
Use canonical full relation/type/routine keys plus grammar extension metadata for catalog/database
identity if existing structural consumers can retain it losslessly. If API consumers require catalog
as a first-class common field, propose an additive bounded `catalog` only with demonstrated tests;
do not fabricate a new schema format merely because the engines have catalogs.

`ResolverSchemaIndex.tables/column` already offer exact and lowercase indexes. Functions/routine
lookup and uniqueColumnSets/isUnique currently fold to lowercase. SQL Server collation semantics can
be case/accent-sensitive and current database/default schema resolve names; DuckDB has its own
casefold/catalog/search-path behavior. Grammar can implement its own lookup and relation evidence.
If sharing index improvements, add an explicit neutral comparison strategy that never turns a
previous ambiguous name into first-match success. Do not globally change quoted-name semantics.

Catalog snapshots must preserve allowlisted settings that affect output: server/compatibility level,
collations, default schema/database, session arithmetic/date/quote behaviors as applicable; DuckDB
extensions, default catalog/schema/search path/timezone/casting settings as applicable. Runtime must
validate or establish the same facts on the actual owned/leased connection. Never blindly trust a
snapshot from a different session. Missing privileges, unknown settings, unresolved temp relations,
linked/attached databases or missing extension metadata remain diagnostic/conservative.

## Maturity integration work outside core

- New grammar package root exports dialect/sql/types/provider; `/query` stays portable and light;
  `/runtime` owns neutral connection execution; explicit `/mssql` or official DuckDB SDK subpath
  dynamically imports the app-installed driver. No stable import reaches preview packages.
- Add packages/examples to root TS references; workspace glob already includes new directories.
  Register packages in `release-manifest.json`, package graph/public API/packed contracts and
  forbidden drivers (`mssql`, `tedious`, `msnodesqlv8`, `@duckdb/node-api`, `@duckdb/node-bindings`,
  `duckdb`, `@duckdb/duckdb-wasm`) as appropriate. Audit transitive and packed dependency graphs, not
  merely source imports. Do not declare stable maturity until qualification artifacts exist.
- `packages/cli/src/init-plan.ts` has the only neutral CLI finite grammar registry (postgres/mysql/
  sqlite and error text). Extend registry/help/generated setup tests for both new package factories.
  Ordinary compiler/build/config/LSP paths are plugin-driven: avoid new SQL semantics there.
- SQL-file and inline factories, conditional/repeated fragments, dynamic queries, scalar brands,
  manifest/compatibility reports, prepared selection, policy hashes and query-value plans must work
  through public published entrypoints in each new grammar's packed consumer.
- `website/.vitepress/theme/playground/dialect-browser-runtime.ts` has a three-grammar union/map;
  `playground.ts` has handwritten schema DDL conversion, namespace defaults and version evidence.
  Add proper per-grammar browser modules/schema examples with no native driver/Node imports. Use
  structural descriptions or conservative DDL handling for nested types/settings rather than
  misleading PostgreSQL schema parsing. Add editor/browser hover/errors/completion/source-range and
  SQL-file tests; update default examples/storage migration and production bundle checks.
- Language-server and ts-bridge load DialectPlugin rather than known grammar enum; add real packaged
  editor/preview conformance fixtures instead of introducing package imports into stable runtime.
- Add feature ledger policies/entries and source/tests/documentation evidence. Ledger numeric scheme
  currently accepts up to three components. SQL Server exact four-part build string belongs in raw
  server.version while grammar-normalized versionKey/line and compatibility level settings select
  behavior. Do not compare SQL Server raw builds or prereleases with a generic numeric coercion.
- Add canonical docs quickstarts/dialect/type-policy/adapter/examples/compatibility pages and sidebar
  metadata; README concise matrix/link entries; update documentation contracts. Supported range,
  exact tested driver/engine versions, platform limitations and unsupported capabilities are separate.
- Performance: add scanner/parser/resolver/native nested decode and large-catalog/structural-fragment
  workloads to performance-budgets.json and scripts/performance-gate.mjs. Existing budgets remain
  meaningful; do not lower thresholds or quarantine regressions to qualify a package.

## Execution and qualification checklist

Each package needs all of the following before its maturity claim:

1. Unit parser/resolver/soundness assertions prove exact row text, ordered parameter tuple, diagnostic
   and UTF-16 source spans for valid/invalid/version/settings-sensitive forms; fuzz/property limits.
2. Built-in/coercion catalog generation is reproducible and grammar-owned with vendor sources;
   overload selection, nullability, aggregates/window empty inputs and domain/UDT behavior verified.
3. Real engine snapshots round-trip canonical format and detect drift (types, nested shape,
   constraints, routines, settings). Incomplete evidence never silently declares exact support.
4. Real driver exact scalar/nested values round-trip signed/unsigned bounds, DECIMAL precision/scale,
   temporal precision/timezones, blobs, JSON NULL versus SQL NULL, enums, typed NULL and empty values.
   Reject impossible precision/transport/policy contracts before dispatch.
5. Same connection lease semantics across root, prepared, streaming, callback transactions and batch:
   cleanup on success/error/abort, drained pending scope work, escaped scope retirement, rollback
   failure quarantine, ownership-aware close, retry recovery and no leaked statements/connections.
6. One typed query produces one declared result shape. Multiple result sets/stored procedures/dynamic
   output batches must be diagnosed or explicit separate capability; do not silently pick first set.
   This needs no broad core multi-result API for ordinary Query<Row,Params>.
7. Live prepare/describe and nonexecuting plans integrate existing neutral protocols where genuinely
   supported; otherwise documented explicit capability/skip, never execute mutation to infer shape.
8. Public conformance v2 covers all layers, features, versions, settings and error classes, with
   mutation/timeout/cleanup policy; packed install proves no workspace links or forbidden driver
   root imports. A small smoke suite alone is insufficient.
9. Representative real-engine + packed-consumer PR gates, full supported floor/ceiling/platform/setting
   matrices and prerelease canary jobs record actual engine/driver/runtime versions and evidence.
   SQL Server native platform restrictions and DuckDB native SDK/platform support must be real-tested.
10. CLI/build/editor/playground/docs/release graph and performance gates pass with previous grammars
    unchanged. Changesets cover every user-visible published change.

## Proposed MR dependency graph

- P0 (planning): reviewed evidence/design/version/maturity matrix, internal only; no support claim.
- N1 (neutral values/transport): recursive native value descriptors + physical metadata propagation,
  hostile-input budgets and repeated-parameter identity; full current grammar regression and pack.
- N2 (lexical primitives, conditional): only demonstrated profile extensions, synthetic public grammar
  proof, fuzz/source spans and scanner budget. Can parallel N1; no vendor syntax in toolkit.
- S1 / D1 (parallel grammar foundations): package identity/version evidence/snapshot/provider/type
  policy/catalog/codecs and independent parser/resolver, with first live probes as real foundations.
- S2 / D2 (parallel mature analysis): DML/OUTPUT/analytical/nested forms, semantics, conformance corpus,
  unknown/dynamic guardrails and all source-range/nullability cases; build on foundations + N1/N2.
- S3 / D3 (parallel execution): app-owned official SDK subpath, real exact wire codec proof, prepare,
  stream/transaction/batch/controls/ownership/error cleanup and live verifier/plan capabilities.
- S4 / D4 (parallel integration): representative + full matrices, packed consumers, CLI, build/editor/
  playground and canonical docs. May be split by review size, but package maturity is a gate over the
  complete dependency stack, not an early label on S1/D1.
- Q (cross-dialect qualification): final review of full matrix, source/metadata/codec agreement,
  published tarballs, forbidden dependency graph, docs/feature ledger and unchanged PG/MySQL/SQLite
  correctness/performance. Publish stable package claims only when this evidence passes.

Branches/MRs should remain reviewable by responsibility. Independent package work can parallelize;
core changes land only after both dialect prototypes confirm their need. SQL Server's exact decimal/
temporal transport is an explicit design decision requiring live proof, not a detail postponed to Q.
