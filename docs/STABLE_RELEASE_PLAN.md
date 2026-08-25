# Stable 1.0 Release Plan

This document tracks the work required before publishing the first stable typed-sql release. It is
more detailed than [`RELEASING.md`](./RELEASING.md): that document defines the release mechanism,
while this one defines the temporary path from the current beta to `1.0.0`.

## Current position

The package architecture, PostgreSQL and MySQL integrations, test infrastructure, trusted npm
publishing, provenance, security release enforcement, and repository protections are in place. The
current public release line is `1.0.0-beta.*` under the npm `next` tag.

The project is not ready to publish under `latest` yet. Stable promotion is blocked by the absence
of a complete registry-only consumer test, an unrehearsed stable version transition, and
insufficient external beta soak time. The editor and public query API boundaries must also be
decided before the 1.0 contract is frozen.

## Definition of ready

The stable release is ready when all of the following are true:

- a clean external project installs typed-sql exclusively from npm and passes the PostgreSQL,
  MySQL, TypeScript, generation, execution, drift, server, and editor scenarios;
- the complete prerelease-to-stable transition has been rehearsed without publishing;
- the intended stable packages are exactly `1.0.0`, with correct internal dependency ranges,
  changelogs, exports, declarations, and tarball contents;
- an RC has been exercised in independent projects for the agreed soak period;
- no open correctness issue can cause typed-sql to confidently report an incorrect row type;
- the stability boundary for the TypeScript preview bridge and editor tooling is explicit;
- the public query and parameter-typing contract is intentionally frozen;
- protected CI passes on the exact commit that is published;
- npm `latest`, GitHub tags, GitHub releases, and provenance all agree on the stable version.

## Milestone 1: Prove a registry-only user installation

The external playground currently installs local `vendor` tarballs and uses pnpm overrides. This is
useful for packed-artifact testing, but it does not prove that the published npm graph works exactly
as a user receives it.

Create a clean registry mode in `typed-sql-playground` that:

- installs `@typed-sql/*@next` from npm;
- contains no workspace links, `file:` dependencies, local tarballs, or typed-sql overrides;
- starts fresh from an empty `node_modules` and a newly resolved lockfile;
- installs database drivers only in the consumer project;
- generates PostgreSQL and MySQL artifacts from real schemas;
- typechecks with the supported TypeScript 7 version;
- verifies exact inferred result types for simple and complex queries;
- exercises CTEs, joins, aliases, nullable relations, enums, database functions, and parameters;
- executes the generated queries against real PostgreSQL and MySQL containers;
- exercises the fake GET server and verifies its response type and runtime output;
- detects schema drift for both dialects;
- starts the language server from the installed package;
- verifies the documented Zed and VS Code installation paths outside the monorepo.

Acceptance criteria:

- one reproducible command provisions databases, installs registry packages, generates artifacts,
  typechecks, executes runtime tests, checks drift, and shuts down cleanly;
- the test fails if any typed-sql package resolves from the repository or local filesystem;
- the installed package graph contains no database driver unless the consumer selected it;
- editor hover output shows the same exact row types as the compiler result.

## Milestone 2: Decide the 1.0 package boundary

The core inference path targets TypeScript 7, while `@typed-sql/ts-bridge` currently uses a
TypeScript 7.1 development snapshot and the editor integrations still have development-oriented
installation paths. A stable version must not imply a stronger compatibility promise than the
upstream API allows.

Recommended decision:

- stabilize `@typed-sql/core`, `ast`, `schema`, `config`, `compiler`, `postgres`, `mysql`, and `cli`;
- keep `@typed-sql/ts-bridge` and `@typed-sql/language-server` explicitly experimental until the
  TypeScript API they require is stable;
- keep editor extensions experimental until their supported installation and upgrade paths are
  tested outside the repository;
- update the release manifest and assertions to support separate stable and experimental release
  trains.

Alternative decision:

- delay every package's `1.0.0` until the TypeScript 7.1 bridge API and editor distribution are
  stable enough to support as part of the same contract.

Acceptance criteria:

- the selected package boundary is represented in release automation, manifests, documentation,
  compatibility tables, and npm dist-tags;
- experimental packages are unmistakably labeled and do not receive a misleading stable tag;
- supported editors have a user-facing installation procedure that does not rely on the monorepo.

## Milestone 3: Freeze the public query contract

Typed result rows are the core 1.0 feature. Interpolated parameter values still cross parts of the
public API as `unknown`, so the future parameter-typing direction must be decided before freezing
`Query<Row>`.

Decision options:

1. Introduce a future-compatible parameter type now, such as `Query<Row, Parameters>`, even if the
   first stable compiler cannot infer every parameter.
2. Keep `Query<Row>` for 1.0 and explicitly document parameter inference as a post-1.0 feature,
   after proving that it can be added without breaking existing consumers.

Work:

- inventory every public export and generic type in all intended stable packages;
- write public type-contract tests for query construction, execution, adapters, and generated APIs;
- prove the chosen parameter evolution path with a small compatibility prototype;
- document the supported SQL/type behavior and the deliberately unsupported cases;
- classify confidently wrong inferred types as release-blocking correctness defects.

Acceptance criteria:

- the parameter-typing decision is documented and tested;
- a future parameter feature does not require an avoidable breaking change;
- all stable exports have intentional names, generic ordering, variance, and runtime behavior;
- no generated-path import is required for the normal public API.

## Milestone 4: Rehearse stable versioning and publication

The repository remains in Changesets prerelease mode and `release-manifest.json` still declares the
beta channel. The entire transition must be tested on a disposable branch or isolated worktree
without publishing to npm.

Rehearsal sequence:

```sh
pnpm changeset pre exit
pnpm version-packages
pnpm release:assert stable
pnpm release:verify
```

The rehearsal must additionally inspect every `pnpm pack` result and simulate the stable publisher's
package order and retry behavior.

Work:

- add automated coverage for the stable release path, not only the beta publisher;
- test the current prerelease state before relying on `changeset pre exit`;
- switch the rehearsed manifest to `channel: stable` and `npmTag: latest`;
- ensure only the selected stable packages become exactly `1.0.0`;
- verify internal dependency ranges resolve to the intended stable or experimental versions;
- verify all package changelogs and the root release notes;
- test interrupted and partially completed publication recovery;
- confirm that a stable workflow dispatch cannot publish a beta version or use the `next` tag.

Acceptance criteria:

- the rehearsal produces a deterministic, reviewable diff;
- `release:assert stable` and the complete CI suite pass;
- clean tarball installations succeed without workspace metadata;
- the stable publisher is safe to retry after any package boundary;
- no command in the rehearsal writes to npm or creates a public GitHub release.

## Milestone 5: Publish a final beta and release candidate

After the security, registry-consumer, API, and release-path work is complete:

1. publish the fixes as the next beta, expected to be `beta.3` or later;
2. run the complete registry-only playground against that beta;
3. publish `1.0.0-rc.0` under `next` once the beta is clean;
4. test the RC in independent projects that do not share the monorepo configuration;
5. allow an agreed soak period, recommended as one to two weeks;
6. require at least three representative consumers across PostgreSQL, MySQL, and editor usage;
7. publish another RC whenever a release-blocking fix changes generated output, inference,
   runtime contracts, package exports, or release mechanics.

During the soak, track:

- incorrect inferred types;
- valid queries rejected by the compiler;
- invalid queries accepted without diagnostics;
- introspection or generation nondeterminism;
- driver/version interoperability;
- package installation and export failures;
- language-server crashes or editor configuration failures;
- documentation gaps that prevent a clean installation.

Acceptance criteria:

- the agreed soak period completes without an unresolved release-blocking issue;
- all representative projects can upgrade using only npm versions;
- generated output is deterministic and checked into consumers without unexplained churn;
- every reported correctness issue has a regression test before resolution.

## Milestone 6: Repository and documentation cleanup

Before the stable version PR:

- remove the stale deleted-document reference from `.changeset/README.md`;
- make the root README show the registry-first installation and stable package boundary;
- ensure package READMEs describe only exports and commands that exist in their packed artifacts;
- update compatibility documentation with exact TypeScript, Node.js, PostgreSQL, MySQL, pg, mysql2,
  Zed, and VS Code support levels;
- document which editor functionality is stable and which remains experimental;
- verify every local documentation link and command from a clean checkout;
- prepare concise stable release notes with known limitations and upgrade guidance.

Acceptance criteria:

- no stale roadmap, deleted-document, workspace-only, or prerelease instruction remains in stable
  user documentation;
- documentation commands pass when copied into a clean external project;
- open dependency-update PRs have an explicit disposition before the version commit.

## Milestone 7: Publish `1.0.0`

Create a dedicated version PR only after every previous milestone is complete.

Version PR checklist:

- exit Changesets prerelease mode;
- set the release manifest to the stable channel and `latest` npm tag;
- set every selected stable package to exactly `1.0.0`;
- preserve explicit prerelease versions for packages outside the stable boundary;
- update every internal dependency range;
- update package changelogs and release notes;
- run the complete protected CI suite on the exact proposed commit;
- review packed contents and install them in isolation;
- obtain the required repository and npm environment approvals.

After the version PR merges:

1. dispatch the protected Release workflow with channel `stable`;
2. verify every expected npm version and dist-tag;
3. verify provenance and the trusted GitHub publisher identity for every package;
4. verify immutable Git tags and the GitHub release point to the published commit;
5. install `@typed-sql/*@latest` into a new empty project;
6. rerun the registry-only PostgreSQL and MySQL smoke tests;
7. verify that `next` remains intentional and does not unexpectedly replace `latest`;
8. announce the stable release only after all registry and runtime checks pass.

## Release sequence

The intended order is:

1. complete the registry-only playground;
2. decide the package stability boundary;
3. freeze the public query contract;
4. rehearse the stable transition and recovery path;
5. publish the final beta;
6. publish and soak an RC in independent projects;
7. finish repository and documentation cleanup;
8. merge the stable version PR;
9. publish and verify `1.0.0`.

Stable promotion must stop if any step reveals a confidently wrong inferred type, an unsafe release
path, a broken clean registry installation, or a security issue that meets the release-blocking
threshold.
