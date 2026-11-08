---
title: Query manifests
pageType: how-to
description: Emit deterministic, secret-free query metadata for CI, deployment checks, and production correlation.
---

# Query manifests

A query manifest turns compiler analysis into a versioned JSON artifact. It records every statically visible query, its bounded structural variants, inferred parameters and results, semantic dependencies, capabilities, diagnostics, and observation fingerprints.

The same artifact is the offline input to [live verification](./live-verification.md), which compares compiler evidence with native database prepare metadata and writes a separate secret-free proof.

Application code does not import the manifest. Queries use the selected grammar’s `sql` tag or a [SQL-file factory](./sql-files.md). For example:

<LiveQueryExample dialect="postgres" filename="src/queries.ts">
<template #source>

```ts
import { sql } from "@typed-sql/postgres";

export const account = sql`
  SELECT users.id, users.email
  FROM users
  WHERE users.id = ${42n}
`;
```

</template>
</LiveQueryExample>

## Configure the output

List the TypeScript projects that contain queries and optionally select an output path:

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: { file: "src/generated/db/schema.json" },
  outDir: "src/generated/db",
  projects: ["tsconfig.json", "packages/jobs/tsconfig.json"],
  manifest: {
    outFile: ".typed-sql/queries.json",
  },
  typePolicy,
});
```

Generate the artifact:

```sh
pnpm exec typed-sql manifest
```

`--project` analyzes one explicit tsconfig instead of the configured project list. `--out` overrides the configured output path.

The command asks the workspace TypeScript executable for the files selected by each tsconfig. SQL parsing and inference still run through the grammar-neutral typed-sql compiler and the configured dialect; the compiler package does not depend on TypeScript preview APIs.

## Imported SQL files

Literal relative or absolute `.sql` imports and re-exports in the configured TypeScript source graph
are included alongside inline templates. A missing imported SQL file fails discovery; unrelated
migration scripts are not collected. Package aliases and computed paths are not discovery routes.

Named and repeated bindings are analyzed through the same frontend as their generated factories.
Manifest parameter descriptions follow the expanded SQL occurrence order, which can differ from
the factory's logical argument order. SQL-file locations and dependency spans refer to the original
source, and each asset's content hash participates in stale-proof rejection.

See [SQL files and application identities](../examples/sql-files-and-identities.md) for a complete
example and its verification, plan, and migration-compatibility workflows.

## Artifact contents

Format version 1 contains:

- the compiler version, dialect id, grammar version, fingerprint algorithm, schema format, canonical schema hash, and type-policy hash;
- a capability fingerprint used to invalidate incremental analysis when normalized server evidence changes;
- checkout-relative project and source paths plus content hashes for incremental reuse;
- one source-located entry for each static query or explicit `sql.dynamic()` escape hatch;
- a resolved query's aggregate fingerprint, structural variants, hashed branch choices, row and parameter literals, column and parameter descriptions, and semantic evidence;
- exact, conservative, or unsupported capability evidence only for declared capabilities used by that query or structural variant;
- an unresolved query's diagnostic codes, severities, source ranges, and either `diagnostic` or `dynamic` reason.

Each structural query remains one manifest entry. Its bounded variants are nested under that entry instead of duplicating the source query. Variant fingerprints match the identities emitted by runtime observation, allowing telemetry to correlate with compiler evidence without recording SQL text.

Entries are sorted by relative file and source position. Object keys use canonical order, so unchanged inputs produce byte-identical output even when a checkout moves to another absolute directory.

## Security boundary

The manifest never serializes:

- absolute paths;
- database URLs or connection configuration;
- runtime parameter values;
- environment values;
- SQL source text.

It does contain relative source paths, database object names, TypeScript type descriptions, diagnostic codes, and semantic classifications with source ranges. Human-readable grammar diagnostic messages, fixes, branch expressions, and evidence descriptions are deliberately excluded because third-party grammars may derive them from source text. Treat the remaining fields as application metadata and apply the same artifact access policy used for source maps or build reports.

Static SQL literals influence fingerprints but are not reversible from their SHA-256 digest. A fingerprint is an identity for correlation, not a security signature.

## Unresolved queries and exit codes

The manifest is written even when it contains unresolved entries. This makes unsupported or intentionally dynamic work visible rather than silently omitting it.

| Exit code | Meaning |
| ---: | --- |
| `0` | The manifest was written and every entry resolved. |
| `2` | The manifest was written and contains one or more unresolved entries. |
| `1` | Configuration, project discovery, schema loading, or artifact generation failed. |

A CI job can decide whether unresolved entries are permitted while always retaining the produced artifact:

```sh
set +e
pnpm exec typed-sql manifest --out artifacts/typed-sql-queries.json
status=$?
set -e

if [ "$status" -eq 1 ]; then
  exit 1
fi
```

Projects that commit the manifest can additionally run `git diff --exit-code -- .typed-sql/queries.json`. Projects that do not commit it can upload the file as a build artifact for deployment verification or production correlation.

## Incremental generation

When the output file already contains a compatible manifest, generation reuses entries for source
files whose content hash is unchanged. A compiler, format, fingerprint algorithm, dialect, grammar,
schema format, schema content, type-policy, or resolved-capability change invalidates reuse conservatively. This includes
relevant server versions, settings, extensions, and compile options recorded by the snapshot.

The production performance gate measures both a full 250-query build and an unchanged incremental build. See [Performance](../concepts/performance.md) for the current regression budgets.

## Programmatic API

`@typed-sql/compiler` exports:

- `buildQueryManifest(options)` for in-memory source inputs and optional previous-manifest reuse;
- `serializeQueryManifest(manifest)` for canonical JSON;
- `parseQueryManifest(value)` for compatible reader validation;
- `listProjectSourceFiles(options)` for tsconfig file enumeration;
- `QUERY_MANIFEST_FORMAT_VERSION`, `QUERY_FINGERPRINT_ALGORITHM`, and `QUERY_MANIFEST_JSON_SCHEMA` for consumers.

Format readers accept additive object properties within format version 1. An incompatible required-field or meaning change increments `formatVersion`. A documented fingerprint normalization change uses a new `fingerprintAlgorithm`. Consumers must reject unsupported format or fingerprint versions instead of interpreting them optimistically.


## Consume durable query contracts in a compiler host

`@typed-sql/analysis` provides a programmatic contract format for compiler integrations.
A query contract binds exact rendered SQL to a grammar/profile, schema, database context,
decoding policy, codec revision and interpreter revision. Its application types derive from
validated runtime value descriptors. It does not contain executable TypeScript or application
parameter values.

Compiler hosts can persist an explicit input set with `exportQueryContracts(directory, contracts)`
and reload it with `loadQueryContracts(directory)`. The directory contains a content-addressed
`contexts/` and `queries/` tree and an atomic `manifest.json`. Only objects listed in that manifest
are inputs. Missing, corrupt or conflicting objects fail loading; old unreferenced objects do
not supply missing support. Exporting a replacement set publishes a new manifest and retains
old objects. This API does not prune them.

Pass the loaded contracts, their expected `QueryContractContext`, and a lightweight grammar
profile to `createContractDialect`. The profile supplies rendering, snapshot validation and
policy information without an `analyze` implementation. The returned dialect can be passed to
existing compiler APIs. A matching contract supplies ordered parameter descriptors, result
columns and the runtime value plan. A SQL, schema or policy mismatch produces `TSQ406`.
Repeated fragments require additional invariance evidence and are conservatively rejected.
Execution effects and cardinality remain unknown.

These APIs consume previously established evidence. Setting a contract's `origin` does not
perform native qualification or prove that an engine supplied it. Contract digests detect
inconsistent contents; they do not authenticate the producer. Use reviewed compiler inputs
from a trusted generator. Application code continues using its grammar's `sql` tag.


### Acquire evidence through an explicit adapter

Compiler hosts can call `acquireNativeQueryContract` with a `NativeContractAdapter`, the expected
context and a static candidate. Candidates contain SQL, every placeholder occurrence and optional
SQL-relative result spans. They contain no application values. The grammar owner accepts only
statement classes and binding behavior it can safely describe before opening a session.

The session supplies context identities and a native description under a declared snapshot or
qualified guard. Acquisition compares context before and after description, snapshots caller
inputs before awaiting, checks adapter identity and parameter layout, and closes the session on
success, failure or cancellation. A changed context or unavailable parameter identity prevents
contract acquisition. The session owner remains responsible for the consistency guarantee;
before/after equality alone cannot establish an engine's snapshot semantics.

Native evidence records sanitized descriptors and known/unknown facts separately for native
identity, runtime representation and nullability. Unknown nullability projects to a nullable
application type. A known SQL family with incomplete modifiers remains partial when consumed.
Unknown result representations remain `unknown`. Contract loading validates that evidence and
the runtime value plan agree. A lightweight profile must establish the same placeholder layout
before consuming a parameterized native contract.

This acquisition API is separate from [live verification](./live-verification.md): it does not
require a resolved compiler claim. Adapter implementations and hosts must supply their qualified
context, statement acceptance and descriptor interpretation. Calling the API does not activate
background refresh or change ordinary build network behavior.

### Reconcile independent static claims

`createStaticQueryClaim({ sql, context, analysis })` captures ordered fields and diagnostic codes
from a separate offline analysis. It excludes source paths and diagnostic messages.
`reconcileQueryContract` compares that claim with a fresh native contract through an explicitly
selected grammar contribution and `ContractQualificationPolicy`. It checks SQL/context identity,
contribution identity/version/grammar, result kind, ordered labels and parameter counts, then
invokes grammar-owned comparisons for type and nullability facts. Successful offline analysis
is compared too; it is not accepted as native proof by itself.

The result has one of three statuses:

- `qualified` supplies a contract with a validated qualification report.
- `conflict` supplies a report and no contract because known claims disagree.
- `incomplete` supplies a report and no contract because a required native facet or comparison
  is unavailable.

The report distinguishes compatibility, conservative widening and unavailable facts. Native
nullability records whether a known bound is exact or an upper bound. An upper bound that includes
NULL does not refute a static non-null refinement. Unknown nullability does not confirm it.
Published descriptors use the conservative native plan, so they can be wider than offline types.

A successful proof binds the native evidence, original native contract, static claim digest,
comparison owner and normalized policy. Persist it through the ordinary contract export API.
Set `qualificationPolicyHash` on `createContractDialect` to the digest of the configured policy
returned by `parseContractQualificationPolicy`. Calculate that expected hash from configuration;
do not accept a policy merely because its hash appears in an artifact. A missing or different
proof yields `TSQ406`. This qualifies one supplied query; project hosts own enumeration of every
checked query and structural variant.

For PostgreSQL, `createPostgresContractReconciler` from `@typed-sql/postgres/reconciliation`
provides pure comparison rules for the supported primitive representations, built-in aliases
and nullability bounds. Unsupported structural, opaque or modifier comparisons remain explicit.
Known static invalidity diagnostics stay blocking when the engine accepts the statement.
