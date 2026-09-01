---
title: Architecture
description: Understand typed-sql's separation between query contracts, SQL grammars, schema metadata, drivers, and editor tooling.
---

# Architecture

typed-sql separates the application query contract, SQL grammar, schema metadata, database-driver integration, and developer tooling. Each package owns one part of that boundary.

## Package responsibilities

| Package | Responsibility | Installs a runtime driver |
| --- | --- | --- |
| `@typed-sql/core` | SQL tag, query and fragment types, rendering, database and dialect contracts | No |
| `@typed-sql/opentelemetry` | Optional bridge from the neutral observer contract to OpenTelemetry spans | No |
| `@typed-sql/ast` | Grammar-neutral tokenizer profiles, bounded cursor mechanics, tree walking, and source ranges | No |
| `@typed-sql/config` | Dialect-neutral project config discovery and loading | No |
| `@typed-sql/schema` | Snapshot envelope, deterministic generation, hashes, and drift | No |
| `@typed-sql/compiler` | Dialect-neutral extraction, transforms, diagnostics, manifests, verification, plan governance, and migration analysis | No |
| `@typed-sql/conformance` | Public executable contract for first- and third-party SQL grammars | No |
| `@typed-sql/postgres` | PostgreSQL grammar, catalog model, resolver, type policy, and codecs | No |
| `@typed-sql/mysql` | MySQL grammar, catalog model, resolver, type policy, and codecs | No |
| `@typed-sql/sqlite` | SQLite grammar, dynamic-type model, introspection, and optional built-in Node adapter | No |
| `@typed-sql/cli` | Snapshot generation, checking, drift, manifests, verification, plan governance, compatibility, and provider discovery | No |
| `@typed-sql/ts-bridge` | Experimental TypeScript semantic overlay and isolated preview bridge | No |
| `@typed-sql/language-server` | Experimental TypeScript and LSP semantic proxy | No |

Applications select one grammar and explicitly install its driver. Adding PostgreSQL support does not install MySQL, SQLite, or another database client.

## Driver ownership

Grammar packages may refer to driver types, expose driver-specific adapters, and use drivers in their own tests. They do not install runtime drivers for applications.

Driver adapters load the application dependency only when their explicit subpath is used. Missing drivers fail with an actionable install message. This avoids hidden clients, duplicate pools, unexpected install size, and driver lifecycle decisions made by typed-sql.

Observability follows the same direction of dependency. Core defines redacted lifecycle events, runtime adapters emit them, and `@typed-sql/opentelemetry` translates them into spans through an application-owned OpenTelemetry API and provider. Core and dialect packages do not depend on OpenTelemetry.

## Dialect contract

Every grammar implements the same public contract for:

- its exact `sql` module entrypoint;
- parsing and source ranges;
- identifier, quoting, and placeholder rules;
- catalog snapshot validation and introspection;
- result-column and ordered-parameter resolution;
- evidence-backed operation, dependency, cardinality, volatility, locking, and connection-affinity semantics;
- database-to-TypeScript mapping;
- runtime encoding and decoding;
- feature and server-version capabilities.

The compiler recognizes the `sqlModule` declared by the configured dialect. It does not branch on package names, dialect ids, or drivers. PostgreSQL, MySQL, SQLite, and third-party grammars use the same compiler and schema infrastructure while owning their SQL semantics.

Core exposes grammar-neutral resolver mechanisms such as indexed catalog lookup, ordered parameter collection, literal-union normalization, and name suggestions. Identifiers, operators, built-ins, nullability, feature gates, and diagnostics remain grammar responsibilities.

The conformance package depends only on neutral compiler and core entrypoints. It turns dialect
claims into executable probes without importing PostgreSQL, MySQL, a driver, or private workspace
source. Grammar repositories own their fixtures and run them with their preferred Poku-compatible
test command.

Every successful analysis also returns versioned `QuerySemantics`. A semantic fact includes the source evidence that supports it. Dependencies distinguish schema-resolved objects from syntactic references, and unsupported or ambiguous statements return unknown semantics. For conditional composition, the compiler merges all possible branches conservatively: dependencies and capabilities are combined, cardinality widens, and the highest-risk volatility, locking, or connection requirement wins.

Compiled queries expose a path-independent SHA-256 fingerprint and the fingerprints of their structural variants. These identify compiler artifacts; they do not contain parameter values and are not a security signature.

The optional query manifest serializes the same fingerprints, variants, inferred descriptions, and semantic evidence in canonical order. It contains relative source locations but no SQL text, parameter values, connection configuration, or absolute paths. Runtime observation can therefore correlate a variant fingerprint with build-time evidence without moving driver or telemetry concerns into the compiler.

Live verification follows the same dependency direction. Core defines a native metadata adapter contract, grammar driver subpaths implement it, and the compiler compares evidence and emits a deterministic proof. The CLI reconstructs SQL transiently only after the source still matches the manifest. Neither the manifest nor proof stores SQL, values, connection configuration, absolute paths, or driver errors.

Query-plan governance reuses that direction. Core owns neutral inspector, environment, sample-provider, and budget contracts. Driver subpaths translate native structured plans into a small grammar-normalized node inventory. The compiler captures fingerprint-keyed evidence and reviews it without importing a driver; the CLI alone coordinates explicit live access. Plan artifacts exclude SQL, values, conditions, sample labels, connection configuration, and raw driver failures.

Migration compatibility remains on the artifact side of that boundary. The compiler compares public snapshots and manifests without knowing how a migration was authored or applied. It maps catalog changes through grammar-owned dependencies, analyzes both mixed-version deployment directions, and emits a deterministic report. Existing migration runners remain responsible for execution and can provide an after-snapshot through any configured `SchemaProvider`.

Runtime routing follows the same semantic ownership. Core turns proven operation, volatility, locking, and connection-affinity facts into a conservative role decision. Dialect packages reuse their parser and resolver for immutable query shapes. Applications supply and own primary and replica adapters, health policy, lag policy, and lifecycle. Unknown evidence always selects primary.

## Generated metadata

Generated output contains schema metadata for tooling and review. Application code imports `sql` and `typePolicy` from the dialect package and imports a driver adapter only when it needs introspection or execution.

A custom type policy belongs in an application module shared by config and runtime. Generated output is never an application API entrypoint.

Query manifests are build artifacts rather than generated application APIs. Applications continue importing `sql` from their selected grammar package. See [Query manifests](../guides/query-manifests.md).

Verification proofs are CI artifacts rather than runtime dependencies. See [Live verification](../guides/live-verification.md).

Compatibility reports are review and CI artifacts rather than migration instructions. See [Migration compatibility](../guides/migration-compatibility.md).

## Composition model

The core runtime stores immutable SQL and parameter segments. It does not interpret clauses.

- `SqlFragment<Parameters>` represents trusted static structure and ordered values.
- `sql.where()`, `sql.and()`, and `sql.or()` compose optional predicates.
- `sql.append()` combines a static base with directly visible fragments.
- `sql.empty` represents zero structural content.
- Conditional templates are expanded into a bounded set of complete statements before grammar analysis.

The compiler owns static extraction and structural expansion. The selected grammar analyzes only complete SQL statements.

## Correctness boundary

Only static SQL supported by the configured grammar receives exact inference. Dynamic identifiers, unsupported syntax, ambiguous resolution, or missing schema evidence produce diagnostics or `unknown`, never `any`.

Editor inference is a development aid. CI correctness comes from the same compiler transform through `typed-sql check`, and runtime execution does not depend on an editor process.
