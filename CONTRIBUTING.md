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

The suite downloads VS Code 1.134.0 and installs the VSIX into separate extension/profile
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

### Shared editor/grammar hub

`test/editor-hub/` owns grammar-specific snapshots, source programs, expected types and shared
interface assertions. Host adapters supply observed hover, completion, diagnostic, definition
and unsaved-edit behavior. Add cases here rather than copying grammar expectations into editor
adapters. These are representative integration fixtures, not all syntax or server-version coverage.

Each run writes `matrix.json` beside individual results, crossing VS Code/Zed, four grammars and
the interface inventory. Missing and unimplemented cells stay `not-run`; protocol evidence is
rejected as host evidence. Failures remain failures and prevent the host command from passing.
The current VS Code host executes eight checks per grammar plus three independent trust scenarios.
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
skips versions that already exist, publishes only the missing suffix of the manifest-ordered train,
and creates release tags only after every package exists. If publication or tag creation fails,
rerun the protected Release workflow with the same channel and commit. Do not create another
Changeset or version commit for a partial publication.

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
