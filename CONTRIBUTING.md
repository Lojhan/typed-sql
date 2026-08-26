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
