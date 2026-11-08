# Hybrid analysis design research

Research date: 2026-11-07. This is a repository design investigation, not an implemented feature
or an exact-version qualification report. The final target architecture is [spec.md](./spec.md).
The measured distribution baseline is in [bundle-size.md](./bundle-size.md).

## Existing repository integration points

The working tree was inspected without changing implementation code. It includes in-progress
changes from the preceding implementation, so source findings below identify extension points,
not released guarantees.

| Source | Observed role | Design implication |
| --- | --- | --- |
| [core types](../../packages/core/src/types.ts) | Synchronous dialect analysis, typed config, optional schema provider and lazy live verification | Introduce explicit acquisition capability/configuration; do not make the analysis callback asynchronous |
| [compiler extraction](../../packages/compiler/src/compiler.ts) and [structural expansion](../../packages/compiler/src/structural.ts) | Extract queries and bounded structural variants | Native candidate extraction must work even when semantic analysis is unresolved |
| [query manifest](../../packages/compiler/src/manifest.ts) | Deterministic project query inputs and resolved/unresolved variants | Reuse identities/serialization; add an acquisition contract rather than calling a resolved manifest sufficient |
| [verification](../../packages/compiler/src/verification.ts) | Rebuilds and compares compiler claims with supplied native metadata | Verification is an independent check, not currently a universal supplier of missing inference |
| [config loader](../../packages/config/src/index.ts) | Content/dependency-aware config cache with explicit importer boundary | Adapter selection must stay lazy and invalidatable; evaluating config must not connect |
| [language server](../../packages/language-server/src/index.ts) | Existing schema/analysis/inspection caches and generation invalidation | Reuse host lifecycle; add a separate native request scheduler and immutable artifact view |
| [CLI](../../packages/cli/src/cli.ts) and [init planning](../../packages/cli/src/init-plan.ts) | Existing `.typed-sql` manifests/proofs/plans and whole-directory ignore setup | Allocate a subnamespace; put durable exports outside the ignored cache by default |
| [audit registry](../../scripts/language-audit/native-description/index.ts) | Independent native description owners | Reuse the architectural boundary; production adapter extraction still needs stable APIs, budgets and lifecycle |
| [catalog specification](../grammar-completeness/spec.md) | Source locks, IR, qualified profiles and explicit distribution separation | Retain the foundation while replacing universal offline semantic parity as the required product boundary |

The current verification API expects compiler claims. Supplying unresolved contracts requires
additional extraction, reconciliation, policy and decoding behavior. Renaming verification as
generation would leave those gaps unimplemented.

## Native metadata: what it establishes

| Engine | Relevant official mechanism | Consequence for the design |
| --- | --- | --- |
| PostgreSQL | Statement Describe supplies parameter/result descriptions; result fields include type OID and modifier, plus table origins when available | Useful query identity metadata; no general expression-nullability or cardinality field in RowDescription |
| MySQL | Native preparation returns parameter/column definition blocks; optional metadata negotiation can omit definitions | Require complete available descriptors explicitly and qualify whether parameter information is meaningful |
| SQL Server | First-result-set description reports logical types, dimensions and nullability but can reject unsupported batches | Treat rejection/ambiguity as scoped outcomes; do not convert arbitrary batches into assumed query contracts |
| DuckDB | Prepared-statement API exposes result logical types, with documented version availability | Preserve nested logical structure and gate by exact API/profile capability |
| SQLite | Declared-type lookup returns no declaration for expression results; values have dynamic runtime types | Preparation alone cannot give universal expression inference; retain static rules or explicit extension declarations |

Sources: [PostgreSQL extended-query flow](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY),
[PostgreSQL message formats](https://www.postgresql.org/docs/current/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-ROWDESCRIPTION),
[MySQL native preparation](https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_com_stmt_prepare.html),
[SQL Server result descriptions](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-describe-first-result-set-transact-sql?view=sql-server-ver17),
[DuckDB prepared statements](https://duckdb.org/docs/2.0/clients/c/prepared.html),
[SQLite declared result types](https://www.sqlite.org/c3ref/column_decltype.html).

These documents establish API behavior, not qualification for every driver or retained server
profile. The specification requires explicit per-version capability tests. A complete inventory
and a useful description protocol are different capabilities.

## Why query-specific evidence is necessary

A routine catalog can establish signatures and identity, but expression-dependent modifiers,
overload/coercion selection and table outputs require binding context. Reusable semantic rules
therefore need an explicit qualification scope. An exact query contract can preserve a binding
decision without pretending to describe every call to the same routine.

Native metadata also has incomplete facets. PostgreSQL's row-description fields do not include
general expression nullability. SQL Server may conservatively report nullable when certainty
is unavailable and has explicit limitations around temporary tables and some dynamic forms.
Those observations motivate facet-specific evidence and conservative nullability, rather than
one global boolean saying that an entire query is verified. The protocol references above
support those boundaries.

No connection can prove a generated nested JSON object type merely by reporting the native
JSON scalar identity. Likewise, parameter count is not a qualified parameter type, and a
decoder policy is not a native database type. These are design deductions from the distinction
between the supplied metadata and the stronger application contract being requested.

## Invalidation and the limits of server caches

MySQL documents automatic repreparation after relevant metadata changes, using the original
default database and SQL mode. That behavior belongs to a server-side prepared statement; it
does not refresh a persisted application's TypeScript artifacts. The project cache must track
its own context and invalidation rules. [MySQL statement caching](https://dev.mysql.com/doc/refman/8.4/en/statement-caching.html).

SQLite's schema version is a useful schema-change signal, but is not a complete project-context
identity. Connection-specific functions, loaded extensions, attached databases, build options
and semantic settings need separate treatment. The general design deduction is that every
fingerprint must declare its coverage. [SQLite schema version](https://www.sqlite.org/pragma.html#pragma_schema_version).

Request coalescing and a short context-check interval reduce database load. They cannot prove
that a remote database remains unchanged between observations. Consequently the design separates
recorded-context validity, observed freshness and connection status. Offline reuse does not
pretend to perform a live schema check.

## Preparation is not a universal side-effect boundary

The acquisition path must not execute application statements with sample values or use rollback
as a safety substitute. There is a further engine-specific qualification requirement: some
SQLite pragmas can take effect during preparation, including when prefixed by EXPLAIN. A generic
claim that preparing arbitrary SQL is harmless would therefore be false. [SQLite PRAGMA behavior](https://www.sqlite.org/pragma.html).

Some binding mechanisms also need external data to discover a table shape. Whether a particular
adapter can permit that is a capability/policy decision to test, not a default promise of
offline or side-effect-free preparation. The proposal rejects unknown statement/resource
classes instead of obtaining stronger-looking metadata by executing them.

## Design alternatives and selected tradeoffs

| Alternative | Benefit | Cost or limitation | Decision |
| --- | --- | --- | --- |
| Universal offline semantic implementation | New queries need no server | Continual replication of engine binding and expression behavior across versions | Replace as a product completion requirement |
| Database-only inference | Broad server-native binding | New disconnected queries fail; metadata still has missing facets | Use for project/query expansion, not the only layer |
| Persist signatures only | Reusable across many queries | Does not establish dependent results or all nullability/coercion rules | Keep declarations with explicit inference permission |
| Persist exact query contracts | Retains actual binding context | Requires variant/context identity and regeneration | Primary long-tail escape path |
| Qualify all checked project queries natively | Also detects incorrect successful offline inference | Requires a matching qualification database and explicit native limitations | Recommended strongest CI qualification policy |
| Frozen contract-first consumption | Avoids loading global analyzer catalogs for already contracted queries | Requires complete durable contract closure and a lightweight profile entrypoint | Primary frozen compilation path |
| Always connect from analysis callbacks | Automatic lookup | Blocks synchronous compiler/editor paths and ordinary builds | Reject; schedule async refresh in hosts |
| One disposable `.typed-sql` cache | Simple local UX | Cannot support reproducible clean-checkout CI alone | Pair with explicit durable exports |
| Trust cache age as correctness | Cheap hits | Age says nothing conclusive about schema equality | Separate freshness observations from semantic validity |
| Normalize SQL aggressively for hits | Fewer duplicate entries | Hints, settings, literals and placeholder semantics complicate equivalence | Start with exact rendered bytes |
| Guess unknown result modifiers | Appears to cover more queries | False identity proofs and downstream inference errors | Preserve known families and explicit unknown facets |

## Evidence still needed before implementation promises

- A licensed, representative corpus for selecting the offline core; no current popularity
  percentage establishes that a particular 100–200 names is enough.
- A vertical prototype proving extraction, native descriptions, decoder generation, cache
  reuse and frozen export for a currently unresolved query.
- Parameter authority and result-facet matrices for exact supported native transports.
- Fingerprint correctness/cost measurements, especially routine semantics, permissions and
  session-sensitive behavior.
- Benchmarks separating runtime, analyzer and metadata weight; catalog size alone cannot
  establish userland bundle savings.
- Integration tests for structural variants, stale document races, disconnects and writer
  crashes, and a third-party/inherited grammar contribution through the same path.

The proposed live behavior is technically feasible under these boundaries. A universal promise
that every advanced query becomes fully typed after one database call is not supported by the
available native APIs.
