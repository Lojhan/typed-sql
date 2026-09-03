---
title: Upgrade from typed-sql v1
description: Move applications, custom grammars, runtime adapters, and CI artifacts to the v2 contracts.
---

# Upgrade from typed-sql v1

typed-sql v2 keeps the application-facing model introduced in v1: application code imports `sql`
from its grammar package, installs its own database driver, and treats generated schema files as
compiler inputs. The major version changes the grammar and production-artifact contracts rather
than replacing native SQL with a generated client or query builder.

Upgrade all stable `@typed-sql/*` packages used by one application to the same major. Do not mix a
v1 grammar with the v2 compiler or core package. Preview editor packages remain isolated from the
stable compiler path and can be upgraded independently.

## Upgrade an application

The query import does not change:

```ts
import { sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const account = sql`
  SELECT users.id, users.email
  FROM users
  WHERE users.id = ${1n}
`;

const database = await createPgDatabase({ connectionString: process.env.DATABASE_URL!, typePolicy });
const row = await database.one(account);
```

`pg`, `mysql2`, validation libraries, and OpenTelemetry remain application-owned dependencies. The
grammar package does not install them. SQLite is a stable package surface; its optional built-in
`node:sqlite` adapter requires Node 22.13+, 24, or 26 even though the grammar follows typed-sql's
general Node.js range.

After upgrading packages, regenerate and check the project:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --project tsconfig.json
```

Regeneration is required when the snapshot's `dialectVersion` differs from the selected grammar.
It is also recommended for every v1 upgrade because v2 snapshots can record function volatility,
which supplies evidence for routing, retry, manifest, and compatibility decisions. A v1 snapshot
whose neutral `formatVersion` is still supported can be read, but missing evidence remains unknown
rather than being guessed.

The v1 `execute()` and `transaction()` methods remain available. v2 adds `all()`, `one()`, and
`maybeOne()` cardinality methods, cancellation and deadlines, prepared execution, streams, batches,
routing, and optional adapter capabilities. Adopt them incrementally; no production feature is
enabled merely by upgrading the package.

### Regenerate SQLite evidence

SQLite graduation makes several previously broad or provisional outcomes evidence-backed. Regenerate
the snapshot before accepting the new types and diagnostics:

- non-STRICT columns remain the sound SQLite storage union; STRICT columns, rowid aliases, generated
  columns, and `WITHOUT ROWID` keys can now narrow from catalog evidence;
- the default integer result is `bigint`, including rowid and exact `INTEGER PRIMARY KEY` aliases;
- recursive queries, compound selects, windows, UPSERT, `RETURNING`, `UPDATE FROM`, JSON, date/time,
  math, and versioned built-ins now produce exact results when their version and compile evidence is
  present;
- unavailable versions and compile options now report stable `TSQ402`–`TSQ407` diagnostics instead
  of accepting a best-effort type; invalid SQLite-specific invocation shapes can additionally report
  `TSQ220`–`TSQ227`;
- the Node adapter rejects a generated snapshot when the live library version, compile options, or
  type-policy hash differs, and it no longer supports Node 22.11 or 22.12.

Review inferred row and parameter declarations after `typed-sql generate`, then run
`typed-sql check` and the application's runtime tests. If application routines are used, provide the
same explicit declarations during introspection that are installed on the runtime connection.

## Adopt compiler and CI artifacts

Start with a query manifest. It gives every statically analyzed query a path-independent identity
and becomes the input for the other production checks:

```ts
export default defineConfig({
  dialect: postgres(),
  schema: { file: "generated/db/schema.json" },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  manifest: { outFile: ".typed-sql/queries.json" },
});
```

```sh
pnpm exec typed-sql manifest
```

Then add only the checks the application needs:

- [Live verification](./live-verification.md) compares manifest evidence with native database
  metadata and supports a cached offline check.
- [Query-plan governance](./query-plan-governance.md) records redacted structured plans and reviews
  explicit budgets.
- [Migration compatibility](./migration-compatibility.md) compares before/after snapshots and
  manifests in both rolling-deployment directions.
- [Observability](./observability.md) correlates runtime work with compiler fingerprints without
  recording SQL or parameter values by default.
- [Result validation](./result-validation.md) accepts any compatible Standard Schema V1 validator
  without adding a validator dependency to typed-sql.

Generated snapshots, manifests, verification proofs, plan artifacts, and compatibility reports are
versioned inputs. Parse them through the public parser for that artifact instead of casting JSON.
When a parser rejects a version, regenerate the artifact with one coherent package set. Never edit a
version field to make an incompatible artifact appear current.

## Upgrade a custom grammar

The breaking grammar change is `DIALECT_CONTRACT_VERSION` 3 to 4. Every analysis must now return
versioned, evidence-backed `QuerySemantics` beside columns, parameters, diagnostics, and result kind.

A v1 analysis could return only inference evidence:

```ts
return {
  columns,
  parameters,
  diagnostics,
  resultKind: "rows",
};
```

The v2 contract requires semantics:

```ts
import {
  DIALECT_CONTRACT_VERSION,
  unknownQuerySemantics,
  type DialectPlugin,
} from "@typed-sql/core";

const plugin = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  // id, grammarVersion, sqlModule, capabilities, policy, and renderer omitted
  analyze(text, snapshot, policy) {
    const result = analyzeGrammar(text, snapshot, policy);
    return {
      ...result,
      semantics: result.diagnostics.some((item) => item.severity === "error")
        ? unknownQuerySemantics(sourceRange(text), "Grammar analysis reported an error.")
        : analyzeSemantics(text, snapshot),
    };
  },
} satisfies DialectPlugin;
```

Use `defineQuerySemantics()` for successful evidence. It canonicalizes and freezes operation,
dependencies, cardinality, volatility, locking, connection affinity, and capability claims. Use
`unknownQuerySemantics()` until a statement has real grammar or schema evidence. Do not infer a safe
read, retry, or replica route from a SQL prefix.

Increment the grammar's own `grammarVersion` when placeholder behavior, identifier rules, catalog
interpretation, built-ins, coercions, nullability, or inferred types would reinterpret an existing
snapshot. The npm package version does not replace this boundary. Regenerate snapshots after such a
change and reject a mismatched `dialectVersion` in `validateSnapshot()`.

Run the public conformance fixture before publishing. Its required semantic and capability probes
make a fail-closed implementation executable rather than documentary. See
[Author a custom SQL grammar](../extending/custom-grammars.md).

## Upgrade a runtime adapter

Adapters constructed through `createDatabase()` continue to work and gain the portable cardinality
methods. A custom object that directly implements `Database` must also provide
`executionCapabilities`, `all()`, `one()`, and `maybeOne()`. Report cancellation or deadline support
only when the adapter can interrupt native work and clean up its connection conservatively.

Protocol-specific functionality belongs behind a namespaced `AdapterCapability`, not on the neutral
`Database` interface. Consumers discover it with `getAdapterCapability()` or require it with
`requireAdapterCapability()`. This is how grammar adapters can expose COPY, LOAD DATA, or future
native services without teaching core about a dialect or installing a driver.

Live-verification and plan adapters expose their own non-empty `adapterVersion`. Change that value
when native evidence or normalization changes. Cached proofs and plan comparisons include it so
incompatible evidence is not silently reused.

## Upgrade editor integration

Install the current language server in each application workspace and upgrade the VS Code or Zed
launcher at the same time. The application does not install the bridge's TypeScript preview
directly; `@typed-sql/language-server` owns the exact tested preview package.

```sh
pnpm add -D @typed-sql/language-server
pnpm exec typed-sql doctor --protocol 1
```

Keep typed-sql as the only TypeScript language server for the workspace. Remove an older custom
`tsserver.js` path or direct bridge launcher, then restart the editor so every workspace folder uses
the installed server. Existing unversioned typed-sql clients are interpreted as protocol v1, while
current clients explicitly negotiate v1 and the `analysis-identity`, `diagnostic-fixes`, and
`status` capabilities.

If an overridden preview dependency or protocol mismatch is reported, restore the language
server's pinned dependencies and upgrade the launcher and server together. Do not bypass the check:
unsupported TypeScript patches stop before project loading so the editor cannot publish an
optimistic result from an untested compiler API. See [Editor setup](./editors.md) for per-editor
configuration and supported feature limits.

## Version boundary reference

These versions are independent. Their current values describe a contract or artifact generation;
they are not aliases for the typed-sql npm major.

| Public boundary | Current value | Compatibility rule |
| --- | --- | --- |
| `DIALECT_CONTRACT_VERSION` | `4` | A grammar must implement the exact plugin protocol. |
| `QUERY_SEMANTICS_VERSION` | `1` | Semantic evidence must use the exact supported shape. |
| grammar `grammarVersion` | grammar-owned | A snapshot's `dialectVersion` must be accepted explicitly by the grammar. |
| `SCHEMA_FORMAT_VERSION` | `2` | Parse through `parseSchemaSnapshot()`; typed-sql 2 can read isolated v1 snapshots and emits v2. |
| `QUERY_MANIFEST_FORMAT_VERSION` | `1` | Parse through `parseQueryManifest()`; regenerate when unsupported. |
| `QUERY_FINGERPRINT_ALGORITHM` | `typed-sql-v1` | Fingerprints correlate only when the algorithm, grammar, schema, and policy evidence agree. |
| `QUERY_VERIFICATION_FORMAT_VERSION` | `1` | Parse proofs through `parseQueryVerificationProof()`. |
| `QUERY_VERIFIER_VERSION` | `typed-sql-v1` | Cached proof keys must match the neutral verifier and grammar adapter versions. |
| `QUERY_PLAN_FORMAT_VERSION` | `1` | Parse captures through `parseQueryPlanArtifact()`. |
| `QUERY_PLAN_CAPTURE_VERSION` | `typed-sql-v1` | Compare captures only when capture and environment evidence are compatible. |
| `QUERY_PLAN_REVIEW_FORMAT_VERSION` | `1` | Parse review reports through `parseQueryPlanReviewReport()`. |
| `SCHEMA_COMPATIBILITY_FORMAT_VERSION` | `1` | Parse reports through `parseSchemaCompatibilityReport()`. |
| `SCHEMA_COMPATIBILITY_ANALYZER_VERSION` | `typed-sql-v1` | Recompute reports when the analyzer generation changes. |
| `GRAMMAR_CONFORMANCE_VERSION` | `1` | A grammar fixture must implement the exact required probe contract. |
| Standard Schema `~standard.version` | `1` | `sql.validateResult()` accepts structurally compatible Standard Schema V1 validators. |
| live verifier or plan `adapterVersion` | adapter-owned | Change it whenever native evidence or normalization compatibility changes. |

Names such as `typed-sql-v1` identify the first generation of an artifact algorithm. They remain
valid in typed-sql v2 until that particular algorithm changes. Renaming them solely to match the npm
major would invalidate deterministic evidence without changing its meaning.

## Verify the upgrade

An upgrade is complete when the application can perform all of these actions from installed package
exports, without importing generated application APIs or repository source:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --project tsconfig.json
pnpm exec typed-sql manifest
pnpm typecheck
pnpm test
```

If the application adopts live verification, plan governance, or compatibility analysis, also parse
and review the resulting artifacts in CI. Keep database credentials in the executable config or CI
environment; none of the persisted artifacts should contain them.
