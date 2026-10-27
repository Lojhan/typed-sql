# Contributing

typed-sql welcomes focused issues and pull requests, especially when they include a reduced SQL
query, schema fixture, and the expected TypeScript type or diagnostic.

## Set up the repository

You need Node.js 22.11 or newer, pnpm 10.32.1, and Docker or Podman for real-database and
packed-consumer tests.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Use focused checks while developing:

```sh
pnpm quality
pnpm typecheck
pnpm test:soundness
pnpm docs:check
pnpm docs:start
pnpm docs:build
pnpm performance
```

Run real database flows with:

```sh
TYPED_SQL_CONTAINER_ENGINE=podman pnpm e2e:postgres
TYPED_SQL_CONTAINER_ENGINE=podman pnpm e2e:mysql
TYPED_SQL_CONTAINER_ENGINE=podman pnpm e2e:packed
```

Replace `podman` with `docker` when appropriate.

## Maintain dependencies

The development baseline uses Node.js 24 type declarations while runtime compatibility is
verified separately at the documented Node.js minimum and current supported versions. Review
major `@types/node` upgrades explicitly against that runtime matrix; Dependabot continues to
propose compatible updates within the current major. Do not treat a newer type declaration
package as evidence that newer Node.js APIs are available at the runtime minimum.

## Add tests where behavior lives

Tests use [Poku](https://poku.io/) and are ordinary TypeScript programs. Put a test in the package
that owns the behavior. Compiler and grammar changes should assert the inferred row, ordered
parameter tuple, diagnostics, and source spans where relevant.

Unsupported, ambiguous, or dynamic SQL must resolve conservatively to `Query<unknown>` or a
documented diagnostic. Do not introduce `any` or optimistic inference.

New grammar packages implement `DialectPlugin` and keep SQL-specific semantics inside the grammar.
Neutral packages must not branch on a dialect id, package name, server, or driver. See
[Author a custom SQL grammar](https://github.com/Lojhan/typed-sql/blob/main/docs/extending/custom-grammars.md)
for the public contract and `AGENTS.md` for repository invariants.

## Verify the packaged VS Code client

Build the VSIX before running the isolated editor host suite:

```sh
pnpm build
pnpm --filter ./editors/vscode package:vsix
pnpm --filter ./editors/vscode test:host
```

The suite downloads VS Code 1.140.0 and installs the VSIX into separate extension/profile
directories for trusted, Restricted Mode, virtual-workspace and real-overlay scenarios. The first
three use a controlled server probe to assert whether the client executes workspace code. The
overlay matrix uses PostgreSQL, MySQL, SQLite and the synthetic third-party grammar, built workspace
packages and the real language server with the pinned
upstream TypeScript LSP: it checks inferred row hover/completion, TypeScript errors, source-mapped
navigation and unsaved query refresh through VS Code APIs. The built-in TypeScript extension is
disabled in these isolated profiles so it cannot mask missing providers. This is not proof of
all editor features or a packed language-server installation; packed consumers have separate
verification. No personal editor profile is used. Linux CI runs the suite
under `xvfb-run -a`; its isolated Electron process uses `--no-sandbox` for hosted-runner compatibility.

Downloads, profiles and result JSON normally live under `artifacts/editor-host/`. If the checkout
path exceeds Unix socket limits, set `TYPED_SQL_HOST_DATA_ROOT` to a shorter user-owned directory.
Result JSON is also copied into `artifacts/editor-host/results/`; CI excludes downloads and full
profiles from artifact uploads. Runs preserve their unique directories for diagnosis.
Application and extension updates are disabled in these profiles; a pre-launch CLI version
check rejects a mutated cache rather than mixing editor versions. For focused diagnosis,
`TYPED_SQL_HOST_SCENARIOS=postgres-extended` selects named scenarios (comma-separated); omitted
cells remain `not-run`. `TYPED_SQL_HOST_CAPTURE_PREVIEW=true` captures bounded upstream stderr
only for the generated extended fixtures, without changing production log redaction. Do not
point this diagnostic harness at private application projects.

### Shared editor/grammar hub

`test/editor-hub/` owns grammar-specific snapshots, source programs, expected types and shared
interface assertions. Host adapters supply observed hover, completion, diagnostic, definition
and unsaved-edit behavior. Add cases here rather than copying grammar expectations into editor
adapters. These are representative integration fixtures, not all syntax or server-version coverage.

Each run writes `matrix.json` beside individual results, crossing VS Code/Zed, four grammars and
the interface inventory. Missing and unimplemented cells stay `not-run`; protocol evidence is
rejected as host evidence. Failures remain failures and prevent the host command from passing.
The VS Code host implements all 21 inventoried interfaces per grammar, plus three independent
trust scenarios and a controlled lifecycle scenario. Baseline, extended and built-in-coexistence
hosts have disjoint feature evidence. Standalone and native baseline clients are recorded in
separate matrices; the combined feature matrix selects native baseline evidence when present.
Aggregation rejects duplicate interfaces within that selection or mixed host versions.
The extended hosts use a fresh tarball installation, not workspace-linked production packages.
Their five edit cases per grammar also produce `edit-matrix.json`: local/cross-file rename,
document/range formatting and a structural quick fix. Edits are validated against original
buffers, simulated, applied through VS Code and compared with the simulated result. Formatting
must preserve SQL and be idempotent; renames and quick fixes require exact intended changes.
Implemented scenarios are not automatically passing evidence: inspect each run's result JSON.
Each added interface keeps a 25-second eventual-observation bound; the extended process budget
allows every independent check to finish even after an earlier failure. No failed host is retried.
An additional controlled-server host scenario tests missing-path recovery, configuration changes
during startup, automatic process-crash recovery and configuration teardown. It asserts one active
server process and one hover provider after configuration settles. This probes client ownership,
not SQL inference after restart. Separate extended hosts verify real-server configuration restart
with unsaved SQL replay. Real abrupt-crash inference, remote hosts, stale edit rejection by the
editor, every upstream refactor and exhaustive grammar syntax remain outside this inventory.
Schema lifecycle checks write the actual snapshot file while leaving the source buffer unchanged.
PostgreSQL/MySQL/SQLite verify nullability refresh; every grammar verifies incompatible-envelope
rejection, fail-closed inference and recovery after restoring the snapshot. The synthetic fixture
does not derive row types from column metadata, so it tests envelope/recovery behavior only.

Run `pnpm editor:zed:fixtures` after building to prepare the same four projects and workspace-local
Zed settings under a unique `artifacts/editor-hub/zed-*` directory. This only prepares fixtures:
it does not install extensions, launch Zed or assert host behavior. Its matrix remains not run.
Actual Zed execution needs an isolated profile, the built dev extension, a host adapter and exact
version/platform evidence before any Zed cell can pass. See the official
[CLI reference](https://zed.dev/docs/reference/cli) and
[extension development guide](https://zed.dev/docs/extensions/developing-extensions).

Zed 1.25.3 has manual PostgreSQL baseline evidence on macOS arm64 from an isolated profile,
including SQL/native row hover, row completion, diagnostics, same-line definition mapping,
unsaved query changes, and external schema changes. The exact release WASM is also checked in
a fresh host. Default package lookup is verified against an external pnpm symlink, without
an `lsp.typed-sql.binary` override. Node must resolve to a supported version in the editor's
environment. These checks do not establish the broader Zed dialect or extended-feature matrix.

## Investigate static-analysis findings

The optional review toolchain runs ESLint cyclomatic complexity and selected correctness rules,
Biome cognitive complexity and performance-pattern rules, and Knip unused-code analysis:

```sh
pnpm --dir tools/static-review --ignore-workspace install --frozen-lockfile
pnpm review:static
```

This command requires Node.js 22.13 or newer. Its private, separately locked dependencies keep the
analysis parser's TypeScript 6 dependency separate from the repository's TypeScript 7 compiler.
Install the root workspace first for Biome. Reports go to `artifacts/static-review/`; rerunning the
command replaces these diagnostic reports, not source files.

Cyclomatic complexity above 20, cognitive complexity and regex placement are review signals, not
proof of defects or speedups. Knip maps package exports and executable entrypoints to source and
keeps public entry exports out of unused-export deletion candidates. Its remaining findings still
need manual review, particularly signature types, compatibility facades and generated consumers.
Known compiled-output performance consumers have explicit source boundaries in
`tools/static-review/inputs.mjs`; check scripts and generated consumers before removing any export.
Do not automatically remove APIs or merge grammar policy because of a metric.

The command returns failure on tool/configuration errors, empty ESLint/Biome scans or selected
correctness errors; complexity/performance warnings and unused-code candidates are advisory.
It does not replace `pnpm verify`, measured performance budgets, CodeQL or packed-consumer checks.
The report parser and entrypoint mapping have dependency-free tests in the contract suite.

Reference the [ESLint complexity rule](https://eslint.org/docs/latest/rules/complexity),
[Biome cognitive complexity](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/),
[Biome accumulating-spread rule](https://biomejs.dev/linter/rules/no-accumulating-spread/) and
[Knip entrypoint guidance](https://knip.dev/guides/configuring-project-files) when interpreting results.

## Write durable documentation

Public documentation lives under [`docs/`](docs/index.md). Write for application developers first,
use present-tense product language, and link to canonical pages instead of copying large sections
into READMEs. Every public page needs `title` and `description` frontmatter, one H1, and valid local
links. Run `pnpm docs:check` before opening a pull request.

`pnpm docs:start` runs the documentation site locally with live reload. The VitePress shell under
`website/` owns navigation and presentation, while `docs/` remains the only public content source.
Run `pnpm docs:build` to apply the same broken-link and static-rendering checks used for GitHub
Pages.

Maintainer procedures, release mechanics, and automation instructions belong in `AGENTS.md` or
repository configuration rather than the public documentation.

## Recover a release safely

Release publication is append-only. Never unpublish a package version, delete or move a protected
release tag, rewrite release history, or force-push a recovery. Diagnose the failed step against
the exact commit and package version before changing registry state.

The publisher is safe to retry on the same commit. It queries npm for every exact package version,
skips versions that already exist, reconciles missing registry tags, publishes only missing
versions in manifest order, and creates release tags only after publication and tag repair succeed.
It refuses a stale unpublished version and never moves a newer tag backwards. Experimental
companions keep prerelease versions and experimental metadata while both `next` and `latest`
select the current companion, so versionless installation does not select an obsolete backend.
The companion preparation step changes npm state only. Git tags are created by the complete
publisher after the whole train succeeds, inside the Changesets action, so its output report
contains the new tags for remote push and GitHub release creation.
npm can acknowledge publication while a version is still being processed and cannot yet be
installed. Registry acceptance waits up to ten minutes with fresh metadata requests. If that
bound is exceeded, confirm the exact versions and tags are visible before retrying; do not
change a version merely because registry processing is delayed. If publication or tag creation fails,
rerun the protected Release workflow with the same channel and commit. Do not create another
Changeset or version commit for a partial publication.

The protected publishing job uses npm 12.2.1 for OIDC dist-tag operations. For every package's
existing `release.yml` trusted publisher, enable **Allow npm dist-tag** in npm's package settings
while retaining the `npm` environment restriction. See npm's
[trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/). Registry tag repair
fails closed if that permission is absent; no long-lived token fallback is used.

After a stable release, `pnpm version-packages` consumes pending Changesets and prepares a new
coherent RC train rather than a mixture of independently bumped stable versions. Its series is
the highest proposed stable version (at least the next patch), and it includes every stable and
experimental package. Subsequent candidates share the series and increment the RC number.
Promotion still uses the protected candidate evidence and preserves experimental companions.
Prepare aggregate release notes under `.github/release-notes/<series>.md` before accepting the
version PR; historical release notes are not rewritten.

If post-publication verification finds a defect:

1. Preserve the published version and its tags as evidence.
2. If installation must be stopped immediately, first verify the intended prior version with
   `npm view <package> versions --json`, then move `latest` with
   `npm dist-tag add <package>@<known-good-version> latest`. Apply the same decision explicitly to
   every affected stable package; never assume their histories are identical.
3. Fix forward through a reviewed patch release and run the complete protected release workflow.
4. Record the failed and recovery workflow URLs, exact commits, versions, tag changes, and registry
   verification in the release issue.

The Poku release-publisher contract simulates failure and retry at every package boundary and after
tag creation. `pnpm release:rehearse` additionally proves the stable/experimental split, stable-only
packed installation, and the absence of registry or public Git writes in an isolated worktree.

## Describe package changes

Add a Changeset for user-visible package behavior:

```sh
pnpm changeset
```

Use semantic versioning. Breaking public-contract changes require a major version. Documentation-
only repository changes do not require a Changeset unless they alter documentation packaged with a
published module in a way users need to receive as a package update.

Keep commits reviewable and free of database credentials, packet captures, generated build output,
and unrelated formatting changes.

By contributing, you agree that your contribution is licensed under the MIT License.

The editor SDK launchers are built with Go 1.27.3 (the pinned toolchain in
`tools/editor-sdk/go.mod`). Applications consume prebuilt launchers and do not need Go.
`pnpm editor:sdk:build` builds the host launcher; `pnpm build` and
`pnpm editor:sdk:build:all` build macOS,
Linux, and Windows launchers for x64 and arm64 before release artifact inspection.

The root package test command runs package suites one at a time. The SQLite throughput floor is
unchanged; it must run without competing compiler and native-server suites consuming the same CI
worker's CPUs. Dedicated performance budgets remain a separate required gate.

## Publish experimental editor extensions

The `Editor marketplaces` workflow publishes the same experimental prerelease VSIX to Visual
Studio Marketplace and Open VSX under `lojhan`. It runs only from `main`, requires a successful
comprehensive `CI` workflow-dispatch run for that exact commit, records the artifact hash, and
verifies the downloaded artifact before either registry upload. Duplicate versions are skipped
on retry; bump the editor version for new contents. Never delete a published extension version.

Both publishing jobs use OIDC and protected GitHub environments. Direct Marketplace OIDC
requires registry-side support as well as the `vsce --oidc` flag; CLI support alone does not prove
that publisher policies can be configured. Check the live publisher settings and the
[Marketplace backend status](https://github.com/microsoft/vscode-vsce/issues/1275) before dispatching
that registry job. Configure available trusted publishers with these exact fields:

| Field | Visual Studio Marketplace | Open VSX |
| --- | --- | --- |
| Publisher / namespace | `lojhan` | `lojhan` |
| Repository owner | `Lojhan` | `Lojhan` |
| Repository | `typed-sql` | `typed-sql` |
| Workflow | `editor-marketplaces.yml` | `editor-marketplaces.yml` |
| Environment | `visual-studio-marketplace` | `open-vsx` |

Namespace ownership, publisher registration, and any registry publisher agreement must be
completed by the account owner. The workflow deliberately has no PAT fallback. See the official
[VSCE trusted publishing guide](https://github.com/microsoft/vscode-vsce#trusted-publishing) and
[Open VSX trusted publishing guide](https://github.com/eclipse-openvsx/openvsx/blob/main/cli/README.md#trusted-publishing).

After reviewing comprehensive CI evidence, dispatch:

```sh
gh workflow run editor-marketplaces.yml --ref main -f registry=both -f evidence_run_id=<successful-ci-run>
```

Approve the two protected environments after reviewing the built VSIX report. Each registry
job can be retried independently after partial publication. These prerelease uploads do not
promote the editor to stable; the existing editor-promotion evidence policy still applies.

When direct Marketplace OIDC is unavailable, the account owner can upload the exact reviewed
VSIX through the signed-in Marketplace UI. Use `typed-sql-editor-artifacts` from a successful
comprehensive `CI` workflow-dispatch run for the exact `main` commit. Compare the VSIX SHA-256
with `vscode.sha256` in that artifact's `editor-artifacts.json`, and validate the publisher,
extension ID, version, and prerelease manifest with `assertMarketplaceManifest` in
`scripts/editor-marketplace.mjs`. After uploading, verify the public `lojhan.typed-sql` listing
and its prerelease version before reporting publication. This manual route does not configure
automated trusted publishing, and does not use a stored PAT.
