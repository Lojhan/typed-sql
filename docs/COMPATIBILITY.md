# Compatibility and performance

## Release stability

| Track | Packages | 1.0 npm contract |
| --- | --- | --- |
| Stable | `core`, `ast`, `schema`, `config`, `compiler`, `postgres`, `mysql`, `cli` | Move to `1.0.0` under `latest` after all release gates pass |
| Experimental | `ts-bridge`, `language-server` | Remain prerelease under `next` while they depend on TypeScript preview APIs |
| Experimental/private | VS Code and Zed integrations (`0.1.x`) | Source/VSIX development distribution only; no Marketplace or Zed registry stability promise |

The release workflow validates this split from `release-manifest.json`; every public package records
the same classification in `typedSql.releaseTrack`. See [Public API](./PUBLIC_API.md).

| Surface | Supported/tested contract |
| --- | --- |
| Node.js | 22.11 or newer; CI uses 22.11 and release publishing uses 24 |
| pnpm | 10.32.1 |
| npm release CLI | 12.0.2; trusted-publisher management requires at least 11.15.0 |
| TypeScript correctness path | exactly 7.0.2 |
| TypeScript preview bridge | exactly 7.1.0-dev.20260824.1 |
| PostgreSQL | real E2E on official PostgreSQL 18.4 |
| MySQL | real E2E on official MySQL 8.4.11 |
| pg | E2E application owns 8.23.0 |
| @types/pg | PostgreSQL package supplies declarations-only 8.23.1; no runtime driver is installed |
| mysql2 | E2E application owns 3.24.1 |

Database-to-TypeScript mappings, supported driver settings, precision behavior, and live runtime
assertions are defined in [Runtime codec fidelity](./CODEC_FIDELITY.md).

The versioned [production performance gate](./PERFORMANCE.md) reports p50, p95, variance, throughput,
retained heap, and runtime/CPU context for scanner, compiler, structural expansion, core rendering,
and editor analysis. Protected CI warns near the reviewed ceilings and blocks regressions beyond
them. Package-local Poku budgets remain fast guards for parser security, resolver indexing,
structural limits, composition, rendering, and cache bounds. Parser fuzzing runs 2,000 deterministic
arbitrary inputs. Compiler-critical packages enforce at least 95% statements, lines, and functions
plus 90% branches.

PostgreSQL and MySQL currently implement grammar contract `1.0.0`. `grammarVersion` describes the
snapshot/resolution semantics and intentionally does not change for npm-only prerelease or patch
publishes; incompatible grammar semantics require an explicit grammar-version change.

TypeScript 7.0 intentionally has no stable embeddable API. Therefore CLI checks and source
transforms are authoritative, while the preview bridge is isolated behind a process boundary and
can be replaced without changing the grammar or generated-query contract.

The language server installs its exact TypeScript 7.1 preview as an internal dependency and never
looks for a workspace `tsserver.js`. Its beta version and npm `next` tag identify that preview-backed
contract; stable grammar packages do not acquire a preview dependency. Clean packed-consumer tests
launch the installed executable for PostgreSQL and MySQL, while the private editor integrations stay
on `0.1.x` until their editor-store distribution paths are supported.
