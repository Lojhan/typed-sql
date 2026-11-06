# New grammar maturity audit

Internal engineering record for issues #253 (SQL Server) and #254 (DuckDB).
Research date: 2026-11-05. This file is not public product documentation.

## Scope and baseline

The requested deliverable is two first-class grammar packages with application-owned driver
adapters, matching PostgreSQL/MySQL's level of evidence and product integration. A planning PR
or a package skeleton does not complete the request. Feature breadth can differ where database
languages differ, but capability claims must have the same soundness, lifecycle and compatibility
standards. PostgreSQL-specific COPY/pipeline and MySQL-specific protocols do not become artificial
requirements for another engine; appropriate native capabilities need their own demonstrated contracts.

Baseline inspected: packages/postgres and packages/mysql (50 test files combined), the public
feature ledger, core execution/dialect/value-plan contracts, schema v2, compiler SQL modules,
packed consumers, editor distribution and documentation contracts. Existing classifications include
conservative and unsupported features; maturity does not mean claiming every SQL syntax form.

## Completion evidence required

| Area | SQL Server | DuckDB | Evidence required |
|---|---|---|---|
| Grammar ownership | T-SQL parser/AST/resolver/coercions | DuckDB parser/AST/resolver/coercions | No imports of another grammar's internals; parser ownership contracts |
| Version policy | Product + build + compatibility level + edition/SET evidence | Engine + SDK + settings/extensions | Declared supported ranges separate from pinned exact CI targets; future/unknown targets conservative |
| Lexical evidence | Unicode/bracket identifiers, escaped strings, named markers, comments | Quoted identifiers, nested native expressions, $ markers | UTF-16 diagnostics and ordered parameter occurrences; source reconstruction |
| Query inference | SELECT/joins/APPLY/CTEs/TOP/OFFSET and OUTPUT | SELECT/joins/CTEs/windows/QUALIFY/UNNEST and fixed analytical shapes | Row, parameter, diagnostics and source-range conformance together |
| Types and policies | INTEGER/BIGINT/DECIMAL/MONEY/BIT/binary/temporal/JSON/UDTs | Wide integers/decimal/temporal/JSON/LIST/ARRAY/STRUCT/MAP/UNION | Exact transport evidence, nested NULL handling, incompatible policies fail before dispatch |
| Snapshot/provider | SQL Server sys catalogs, permissions and naming/SET policy | DuckDB catalogs, logical types and extensions | Canonical v2 roundtrip, structural type identities and catalog evidence |
| Runtime | Explicit optional driver adapter | Explicit optional Neo adapter | Ownership, buffered/prepared/batch/transaction/stream/control capabilities only when proven |
| Cleanup/error recovery | Requests, statements, pools, transactions, cancellation | Results, statements, connections, instances, file locks | Success, throw, abandoned stream, rollback failure and cancellation race tests |
| Product integration | CLI/compiler/build/editor/playground | CLI/compiler/build/editor/playground | Public root SQL imports, generated declarations, manifests, packaged editors, UI fixtures |
| Distribution | Driver-free grammar root and query subpath | Driver-free grammar root and query subpath | Isolated packed imports, missing-driver error, browser graph and forbidden-driver checks |
| Qualification | Official x86-64 server CI; emulation is not support evidence | Actual native engines for each supported line | Pinned real engines, real adapter outputs versus inferred plans, stored evidence artifacts |
| Documentation/release | Install, policies, limits, exact matrix and examples | Install, nested types, policies, locks, matrix and examples | Canonical docs, navigation and docs contracts; Changesets and release manifest |
| Regression | Existing PG/MySQL/SQLite behavior | Existing PG/MySQL/SQLite behavior | pnpm verify, soundness, pack, coverage and performance budgets |

## Research execution

Three independent agents own SQL Server, DuckDB and shared architecture research. Root owns the
product-wide maturity audit, integration inventory and independent real-driver probes. First-round
findings will be exchanged for cross-review; the final implementation plan must record resolved
objections and remaining experimental claims. Implementation starts only after this review.

Local host is Apple arm64. SQL Server's supported Linux containers require x86-64 hardware, so
real SQL Server qualification belongs on the repository's x86-64 CI runner or a genuine x86-64
server; an emulated local container cannot prove the supported-platform claim. Native DuckDB
SDK probes run locally and independently of the inference implementation.

## Known design decisions still under review

- RuntimeValueType currently covers primitives, JSON, arrays and unions. New nested descriptors
  need bounded, immutable, prototype-safe copying and validation in every recursive consumer.
- The compiler currently omits databaseType from executable value plans. Typed driver binding
  needs grammar-owned native target evidence, including NULL/empty nested values and decimals.
- Neutral schema v2 already supports extension evidence, composite and collection types. A new
  schema version is not justified until an actual representational gap is demonstrated.
- Stock Tedious/mssql decimal decoding is lossy. Stringifying the decoded number cannot provide
  an exact decimal-string policy. A real lossless transport strategy must be demonstrated before
  claiming that capability; neutral core cannot repair values already lost in a driver.
- Dynamic PIVOT/external-file schemas, arbitrary procedural batches, unknown UDTs and extensions
  need explicit schema evidence or conservative diagnostics rather than fabricated result types.

## Integration evidence update

The neutral native value plans and initial transport prerequisite are merged. Both grammar
packages are integrated in draft PR #265; the draft does not establish product maturity.
DuckDB now includes both pinned SDK profiles, runtime-owned and standalone lazy verification
services, and an atomic vector appender. Packed end-to-end CLI replay is still being extended.

Native SQL Server qualification uncovered genuine trailing-NUL and large VARCHAR corruption
in msnodesqlv8 6.2.2, including raw VARCHAR(MAX) results. That SDK remains an explicit restricted
compatibility adapter. The default /odbc implementation uses application-owned Koffi 3.3.7,
unixODBC and Microsoft ODBC Driver 18 with explicit lengths. A synchronous transport prototype
passed large text, binary, exact numeric, temporal and prepared-rebind cases on all four native
engine builds (run 42117721443); the public worker implementation has separate outstanding
cancellation, memory-budget and resource-lifetime review findings. Prototype success does not
qualify production lifecycle behavior. The same workflow's old public adapter stage failed, so
the overall run is not green.

The integration now includes strict 95% line/function/statement and 90% branch package gates,
portable schema validation, packed browser analyses for both grammars, SQL Server native type
comparison in the compiler, and proof-cache invalidation for strict verifiers. Final native
worker, catalog, editor, performance, tutorial, packed distribution and full repository gates
remain required before merge. No coverage exclusions or weakened native-value assertions
substitute for those gates.
