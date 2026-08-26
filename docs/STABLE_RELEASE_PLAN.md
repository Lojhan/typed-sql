# Stable 1.0 Release Plan

This document tracks only the work still required before publishing the first stable typed-sql
release. [`RELEASING.md`](./RELEASING.md) defines the permanent release mechanism; completed
readiness work is documented by the focused contracts linked from the root README.

## Current position

The package architecture, PostgreSQL and MySQL integrations, grammar contract, frozen public API,
typed parameters and structural fragments, editor reliability, security enforcement, repository
protections, trusted npm publishing, registry-only acceptance, and no-write stable rehearsal are in
place.

The project is not ready to publish under `latest` yet. npm `next` must first receive one coherent
beta containing the current package graph—the registry gate correctly rejects the older mixed beta
currently published. That candidate must then complete the representative consumer soak and final
documentation review.

## Definition of ready

The stable release is ready when all of the following are true:

- a clean external project installs typed-sql exclusively from npm and passes the PostgreSQL,
  MySQL, TypeScript, generation, execution, drift, server, and editor scenarios;
- the exact release candidate has completed the agreed representative-consumer soak;
- no open correctness issue can cause typed-sql to confidently report an incorrect row type;
- the public docs describe the frozen API, supported versions, experimental boundaries, and known
  limitations without workspace-only instructions;
- protected CI passes on the exact commit that is published;
- npm `latest`, GitHub tags, GitHub releases, and provenance all agree on the stable version.

## Milestone 1: Publish and soak the final candidate

1. Merge the remaining prerelease changes and publish one coherent beta under `next`.
2. Run [`pnpm e2e:registry`](./REGISTRY_ACCEPTANCE.md) against that beta from a clean npm-only
   consumer.
3. Publish `1.0.0-rc.0` under `next` once the beta is clean.
4. Test the RC in independent projects that do not share monorepo configuration.
5. Allow an agreed soak period, recommended as one to two weeks.
6. Require at least three representative consumers across PostgreSQL, MySQL, and editor usage.
7. Publish another RC whenever a release-blocking fix changes generated output, inference, runtime
   contracts, package exports, or release mechanics.

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
- all representative projects upgrade using only npm versions;
- generated output is deterministic and checked into consumers without unexplained churn;
- every reported correctness issue has a regression test before resolution.

## Milestone 2: Finish stable documentation

Before the stable version PR:

- remove the stale deleted-document reference from `.changeset/README.md`;
- make the root README show the registry-first installation and stable package boundary;
- ensure package READMEs describe only exports and commands present in packed artifacts;
- update compatibility documentation with exact TypeScript, Node.js, PostgreSQL, MySQL, `pg`,
  `mysql2`, Zed, and VS Code support levels;
- document which editor functionality is stable and which remains experimental;
- document supported SQL/type behavior and deliberately unsupported cases;
- verify every local documentation link and command from a clean checkout;
- prepare concise stable release notes with known limitations and upgrade guidance;
- give every open dependency-update PR an explicit disposition.

Acceptance criteria:

- no stale roadmap, deleted-document, workspace-only, or prerelease instruction remains in stable
  user documentation;
- documentation commands pass when copied into a clean external project;
- the release notes accurately describe the stable and experimental package trains.

## Milestone 3: Publish `1.0.0`

Run the final no-write rehearsal on the release candidate:

```sh
TYPED_SQL_CONTAINER_ENGINE=podman pnpm release:rehearse
```

Review and apply `artifacts/stable-rehearsal/stable-release.diff` in a dedicated version PR. The PR
must:

- set every selected stable package to exactly `1.0.0`;
- preserve explicit prerelease versions and pending Changesets for experimental packages;
- change the release manifest to `stable` and `latest`;
- update internal dependency ranges, stable changelogs, and root release notes;
- pass the complete protected CI suite on the exact proposed commit;
- include review of every packed artifact and the isolated installation report;
- obtain the required repository and npm-environment approvals.

After the version PR merges:

1. dispatch the protected Release workflow with channel `stable` from `main`;
2. verify every expected npm version and dist-tag;
3. verify provenance and the trusted GitHub publisher identity for every package;
4. verify immutable Git tags and GitHub releases point to the published commit;
5. install `@typed-sql/*@latest` into a new empty project;
6. rerun the registry-only PostgreSQL and MySQL acceptance suite;
7. verify `next` remains intentional and does not unexpectedly replace `latest`;
8. announce the stable release only after all registry and runtime checks pass.

## Stop conditions

Stable promotion stops for a confidently wrong inferred type, unsafe release behavior, a broken
clean registry installation, a release-blocking security issue, an unresolved RC regression, or a
documentation gap that prevents a supported consumer from installing and validating the library.
