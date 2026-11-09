# DuckDB guarded native query contracts

Each lease owns a fresh checked SDK instance and connection, opens persisted files read-only,
disables external access, extension loading/installation and optimizer evaluation, then captures
metadata and describes one candidate inside a read-only transaction. Candidate values are never
bound or sampled; only native preparation produces parameter and result descriptors.

## Stored-table scope

The profile admits ordinary stored-table projections, stars, filters and joins. References resolve
within the owned database under its default empty search path and ASCII identifier folding.
Relation definitions, column metadata and name resolution now enter the context digest. Table
DDL changes identity even when the caller snapshot has not been refreshed; ordinary DML does not.
The capture admits at most 20,000 non-internal relations and 65,536 columns, failing closed on overflow.

Native table metadata establishes relation identity and known logical column types before candidate
preparation. Views, temporary relations, generated columns, table functions, lateral bindings,
star modifiers, subqueries, CTEs, compounds, grouping/order/limits, lambdas, named function arguments and windows remain unavailable.
Function-family checks include projection expressions, filters and join conditions. Native
nullability remains unknown, including table projections; an outer join cannot borrow a table's
NOT NULL fact. Unresolved parameter types remain unavailable rather than being sampled.

The canonical engine CREATE TABLE text is parsed with the existing grammar-owned generated-column
reader. This works on 1.5.6 as well as 2.0: the
[metadata documentation](https://duckdb.org/docs/lts/sql/meta/information_schema) identifies the
version boundary for native generated-column fields. This uses native dictionary/DDL evidence;
it does not scrape documentation to populate mappings.

## Implicit function binding

DuckDB can lower operators and container syntax into catalog function bindings, even when the
library's AST has no explicit call. The official 1.5.6
[operator transformer](https://github.com/duckdb/duckdb/blob/v1.5.6/src/parser/transform/expression/transform_operator.cpp)
and [operator binder](https://github.com/duckdb/duckdb/blob/v1.5.6/src/planner/binder/expression/bind_operator_expression.cpp)
show this for arithmetic, list construction and extraction, struct/union/map extraction and JSON
operators. Admission records the relevant implicit families and rejects overlapping user macros;
explicit calls still require a consistent, side-effect-free internal scalar family.

A real probe creates a macro named '+', whose body reads a connection-local variable. Preparing
the same SQL before and after a variable change reports INTEGER then BIGINT. The old explicit-call
check admitted it. The new regression fails before the fix and passes afterward. Both checked
SDKs reject overlapping '+', array_extract, list_value, struct_pack, row and struct_extract
macros before producing a contract. Constructors and extraction therefore cannot hide the
session-dependent result type from qualification.

## Qualification evidence

`pnpm --filter @typed-sql/duckdb test:native` discovers qualified engines from the support policy
and exact SDK declarations in the package manifest. Each runs in a fresh child process and asserts
its actual engine version. Missing/ambiguous SDK declarations fail rather than silently skipping a
target. Normal package tests include the additional SDK after the main coverage suite, without
loading two native libraries together or overwriting the main coverage report.

The native test runs with separate 1.5.6 and 2.0 SDK selections. It checks column-driven inference
for an uncast parameter, left joins, star order, decimal dimensions, ordinary defaults, case-folded
identifiers, unsafe relation/function rejection, DML-stable identity and table-DDL invalidation.
Existing tests cover no execution/binding/sampling, ownership, cleanup, cancellation, policy,
unknown inputs, nested results, cached restart and independent conflict detection.

The installed matrix uses actual packed CLI, build, language-server and execution packages.
Joined table queries exercise native-only nested results, frozen declarations, bundling/execution,
unsaved SQL/TypeScript edits, independent type/table DDL refresh and cache-only restart with durable
inputs hidden. Full offline project checks also run while a child holds a native write lock, and
in a second installation without the SDK. These named cases do not establish whole-grammar
or arbitrary custom-extension qualification.
