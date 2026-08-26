# Repository guide

This file records maintainer and automation knowledge. Public documentation belongs under
`docs/` and must remain useful without repository context.

## Product invariants

- typed-sql is grammar agnostic. Neutral packages own shared contracts and mechanics; grammar
  packages own SQL syntax, semantics, built-ins, coercions, nullability, and diagnostics.
- Grammar packages do not depend on database drivers. Applications install a driver only when
  they use its explicit introspection or execution adapter.
- Application code imports `sql` from the selected grammar package. Generated schema files are
  compiler inputs, not an application-facing API.
- Analysis fails closed. Unsupported, ambiguous, invalid, or dynamic SQL resolves to a diagnostic
  or `unknown`, never an optimistic type and never `any`.
- Runtime decoding and compile-time inference use the same type policy.
- TypeScript preview integration stays isolated in `@typed-sql/ts-bridge` and
  `@typed-sql/language-server`. Stable packages cannot depend on preview-backed packages.
- Structural SQL is explicit: use `sql.fragment`, `sql.empty`, `sql.ident`, or trusted
  `sql.raw`. Ordinary interpolated values always become parameters.

## Repository map

- `packages/core`: public query, fragment, diagnostics, dialect, and resolver contracts.
- `packages/ast`: grammar-neutral source and syntax primitives.
- `packages/schema`: snapshot envelope, validation, codecs, and canonical serialization.
- `packages/config`: config discovery and validation.
- `packages/compiler`: TypeScript project integration and generated declarations.
- `packages/postgres`, `packages/mysql`: grammar semantics and optional driver adapters.
- `packages/cli`: introspection and generation commands.
- `packages/ts-bridge`, `packages/language-server`: experimental TypeScript preview integration.
- `editors/`: thin editor integrations over the language server.
- `test/grammar`: shared grammar corpus and conformance fixtures.
- `test/contracts`: package graph, distribution, release, and documentation contracts.
- `e2e/`: real database and packed-consumer verification.

## Development commands

```sh
pnpm install --frozen-lockfile
pnpm quality
pnpm typecheck
pnpm test
pnpm coverage
pnpm verify
```

Useful focused gates:

```sh
pnpm test:soundness
pnpm test:pack
pnpm docs:check
pnpm performance
```

Real database verification requires Docker or Podman:

```sh
TYPED_SQL_CONTAINER_ENGINE=podman pnpm e2e:postgres
TYPED_SQL_CONTAINER_ENGINE=podman pnpm e2e:mysql
TYPED_SQL_CONTAINER_ENGINE=podman pnpm e2e:packed
```

## Testing rules

- Poku tests are ordinary TypeScript programs. Await asynchronous `describe` and `it` calls.
- Put tests in the package that owns the behavior. Reuse the shared grammar corpus for behavior
  that every grammar should satisfy, and add dialect fixtures for grammar-specific semantics.
- Assert inferred row types, ordered parameter tuples, diagnostics, and source spans together.
- Compiler-critical packages enforce their coverage thresholds through the Poku c8 integration.
- Package-boundary changes must keep packed-consumer, forbidden-driver, and public-API contracts
  green.
- Performance-sensitive scanner, resolver, compiler, and query-rendering changes must satisfy
  `performance-budgets.json`. Budget overrides describe known CI classes; they do not excuse a
  regression.
- Editor changes must verify the packaged language server and extension artifacts, not only source
  imports.

## Documentation rules

- Write public pages for application developers first. Put maintainer procedure here or in
  `CONTRIBUTING.md`.
- Public pages use durable present-tense language. Do not publish release plans, promotion gates,
  dist-tag instructions, rehearsal notes, or roadmap checklists under `docs/`.
- Every public page has `title` and `description` frontmatter, exactly one H1, and valid local links.
- `docs/` is canonical. Root, package, editor, and E2E READMEs are concise entrypoints that link to
  the canonical page instead of duplicating it.
- Distinguish a supported range from an exact version tested by this repository.
- Keep install commands versionless unless a page specifically teaches version selection.
- Package READMEs use absolute GitHub links for repository documentation because npm tarballs do
  not contain the root `docs/` directory.
- Update `test/contracts/documentation.test.ts` when the public information architecture changes.

## Changes and releases

- Add a Changeset for user-visible package behavior. Documentation-only repository changes do not
  need one unless they change a packaged contract.
- `release-manifest.json` defines stable and experimental package tracks. Keep stable packages free
  of experimental dependencies.
- npm publication uses GitHub Actions OIDC and the protected `npm` environment. Release workflows
  must remain safe to retry after partial publication.
- `pnpm release:rehearse` is an internal maintainer check for the first stable publication, not a
  public product requirement.
- Never delete or move published versions or protected release tags.
