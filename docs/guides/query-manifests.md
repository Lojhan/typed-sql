---
title: Query manifests
description: Emit deterministic, secret-free query metadata for CI, deployment checks, and production correlation.
---

# Query manifests

A query manifest turns compiler analysis into a versioned JSON artifact. It records every statically visible query, its bounded structural variants, inferred parameters and results, semantic dependencies, capabilities, diagnostics, and observation fingerprints.

The same artifact is the offline input to [live verification](./live-verification.md), which compares compiler evidence with native database prepare metadata and writes a separate secret-free proof.

Application code does not import the manifest or generated query wrappers. It continues importing `sql` from the selected grammar package:

```ts
import { sql } from "@typed-sql/postgres";

export const account = sql`
  SELECT users.id, users.email
  FROM users
  WHERE users.id = ${42n}
`;
```

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

## Artifact contents

Format version 1 contains:

- the compiler version, dialect id, grammar version, fingerprint algorithm, schema hash, and type-policy hash;
- checkout-relative project and source paths plus content hashes for incremental reuse;
- one source-located entry for each static query or explicit `sql.dynamic()` escape hatch;
- a resolved query's aggregate fingerprint, structural variants, hashed branch choices, row and parameter literals, column and parameter descriptions, and semantic evidence;
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

When the output file already contains a compatible manifest, generation reuses entries for source files whose content hash is unchanged. A compiler, format, fingerprint algorithm, dialect, grammar, schema, or type-policy change invalidates reuse conservatively.

The production performance gate measures both a full 250-query build and an unchanged incremental build. See [Performance](../concepts/performance.md) for the current regression budgets.

## Programmatic API

`@typed-sql/compiler` exports:

- `buildQueryManifest(options)` for in-memory source inputs and optional previous-manifest reuse;
- `serializeQueryManifest(manifest)` for canonical JSON;
- `parseQueryManifest(value)` for compatible reader validation;
- `listProjectSourceFiles(options)` for tsconfig file enumeration;
- `QUERY_MANIFEST_FORMAT_VERSION`, `QUERY_FINGERPRINT_ALGORITHM`, and `QUERY_MANIFEST_JSON_SCHEMA` for consumers.

Format readers accept additive object properties within format version 1. An incompatible required-field or meaning change increments `formatVersion`. A documented fingerprint normalization change uses a new `fingerprintAlgorithm`. Consumers must reject unsupported format or fingerprint versions instead of interpreting them optimistically.
