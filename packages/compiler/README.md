# @typed-sql/compiler

The stable, grammar-neutral TypeScript source compiler behind
[typed-sql](https://github.com/Lojhan/typed-sql). It finds static SQL templates, asks the configured
grammar for row and parameter shapes, creates an in-memory TypeScript overlay, preserves source
mappings, emits deterministic query manifests, and compares them with grammar-owned native database
evidence for CI and production correlation. It also compares before/after snapshots and manifests to
find query-level migration breaks in both rolling-deployment directions, and captures fingerprint-keyed
structured plans for explicit regression review.

```sh
pnpm add @typed-sql/compiler
```

```ts
import { compileSource } from "@typed-sql/compiler";
import { postgres } from "@typed-sql/postgres";

const result = compileSource({
  source: 'import { sql } from "@typed-sql/postgres"; const q = sql`SELECT 1 AS value`;',
  dialect: postgres(),
  schema: { formatVersion: 1, dialect: "postgres", tables: {} },
});
```

For batch/editor parity and incremental consumers, `createSourceAnalysisService()` accepts a
serializable `SourceAnalysisRequest` and returns a versioned `SourceAnalysisResult`. The result
contains the same transform and diagnostics as `compileSource`, plus source/project, grammar and
capability, schema, type-policy, compiler-option, and revision identities. `checkFile()` uses this
service and exposes its result as `analysis`.

`compileSource` consumes only `DialectPlugin`; it does not branch on a database, grammar package,
or driver. Compiled queries expose path-independent SHA-256 fingerprints, variant fingerprints,
variant descriptions, and source-mapped semantics merged conservatively across conditional
structure. `buildQueryManifest` turns the same evidence into canonical, secret-free JSON without
generating an application API. Its public options include the structural-variant bound used for
conditional fragments. Application projects normally use the compiler through `typed-sql check`
or the language server.

Source bytes, static query count, structural variants, and generated declaration bytes have finite
defaults and explicit overrides. Exceeding a limit returns `TSQ006`, the unchanged source overlay,
and no inferred query contract. Cancellation raises `AbortError` before a partial result is returned.

Live verification APIs collect transient SQL only after sources still match the manifest, schedule
grammar-owned adapters with bounded concurrency, compare native field evidence, and emit canonical
proofs that contain no SQL, values, URLs, absolute paths, or driver errors.

Plan-governance APIs schedule grammar-owned inspectors, normalize redacted plan evidence, and apply
absolute or environment-comparable relative budgets. Version, schema, settings, statistics, and sample
changes remain explicit uncertainty instead of being treated as a pass.

Migration compatibility APIs consume deterministic artifacts only. They classify source, runtime,
deployment-order, compatible, and unknown outcomes; link affected variants to source and dependency
ranges; and emit canonical reports without SQL, default expressions, credentials, or absolute paths.

Read [Architecture](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/architecture.md),
[Compose conditional SQL](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/composition.md),
[Query manifests](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/query-manifests.md), and
[Live verification](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/live-verification.md),
[Query plan governance](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/query-plan-governance.md),
[Migration compatibility](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/migration-compatibility.md), and
[Inference and safety](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/type-safety.md).

MIT © typed-sql contributors
