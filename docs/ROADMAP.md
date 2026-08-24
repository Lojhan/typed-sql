# Roadmap to 1.0

The roadmap is gate-based: versions advance when their acceptance criteria pass, not on a calendar.

## 0.1 — open-source foundation

- public MIT repository under `Lojhan/typed-sql`;
- reproducible pnpm workspace and Poku suite;
- CI for TypeScript 7, builds and the real PostgreSQL developer flow;
- Changesets-based version and changelog workflow;
- documented security, contribution and package-boundary policies.

## 0.2 — modular package graph

- extract dialect-neutral query contracts into `@typed-sql/core`;
- extract PostgreSQL grammar/resolution into `@typed-sql/postgres`;
- remove `pg` from every package's regular runtime dependencies;
- accept injected structural clients and expose lazy `pg` integration behind a dedicated subpath;
- add a package-graph test that fails if core or grammar gains a forbidden driver dependency;
- pack and install every public tarball in an isolated consumer fixture.

## 0.3 — PostgreSQL language beta

- define and publish the supported PostgreSQL grammar matrix;
- add CTEs, subqueries, aggregates, expressions, `INSERT`, `UPDATE`, `DELETE` and `RETURNING`;
- harden aliases, joins, nullability, arrays, enums, domains, JSON and overloaded functions;
- differential fixtures against real PostgreSQL catalogs and prepared queries;
- fuzz parser/tokenizer inputs and enforce diagnostic/source-range stability.

## 0.4 — project-scale developer experience

- unopened-file and multi-project semantic overlays;
- SQL completion, go-to-definition and safe quick fixes;
- distributable Zed and VS Code extensions;
- compatibility tests across supported TypeScript 7 releases;
- bounded caches, cancellation and large-workspace performance budgets.

## 0.5 — dialect contract validation

- implement `@typed-sql/mysql` against the same compiler contract;
- use `mysql2` only as an optional application-owned peer;
- prove that installing one dialect does not install another dialect or driver;
- document which semantics are portable and which are dialect-specific.

## 0.9 — release candidate

- freeze public APIs, catalog format and diagnostic codes;
- publish migration guides for every pre-1.0 breaking change;
- complete threat model, dependency review and parser resource limits;
- publish performance and compatibility matrices;
- run the full suite against packed artifacts, not workspace links;
- no unresolved correctness bug that can return a confidently wrong row type.

## 1.0 — stable contract

1. Core/compiler/grammar packages have zero regular dependencies on database drivers.
2. Applications explicitly choose and install their dialect and driver.
3. The supported SQL matrix, schema snapshot format and type policies are stable and versioned.
4. CLI and editor inference use the same compiler semantics and diagnostic codes.
5. PostgreSQL static-query inference and runtime codecs pass real-database compatibility suites.
6. Unsupported SQL fails safely as a diagnostic or `Query<unknown>`—never `any`.
7. Releases are reproducible, provenance-attested, changelogged and covered by a security policy.

## Release mechanics

Changesets records package-level semantic changes. Merges to `main` update a release pull request;
publishing remains manual until the 0.2 package graph and isolated-tarball tests are complete. npm
trusted publishing with provenance replaces long-lived registry tokens before the first public
package release.
