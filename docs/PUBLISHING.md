# Publishing typed-sql

This is the operational checklist for taking typed-sql from an unpublished monorepo to the npm
registry. The first public channel is `1.0.0-beta` under the `next` dist-tag. Stable `1.0.0` is
promoted only after the beta has been installed from the registry and exercised by external users.

The machine-readable release intent lives in [`release-manifest.json`](../release-manifest.json).
Release-contract tests require every public package to remain in that release series/channel and to
ship its README, license, changelog, compiled JavaScript, and declarations. Changesets may advance
individual `beta.N` counters independently.

## Responsibilities

Repository automation can build, test, pack, publish with OIDC, create tags, and create GitHub
releases. A maintainer must perform the npm identity operations that cannot safely be automated:

1. own or create the `typed-sql` npm organization;
2. enable account-level two-factor authentication;
3. bootstrap each package once with interactive authentication;
4. configure each existing package to trust this repository's `release.yml` workflow;
5. approve the protected `npm` GitHub environment for releases.

Never commit an npm token or place a long-lived publish token in GitHub Actions.

## Phase 1: local and CI preflight

Use Node 24 and the pinned pnpm version. Start from a clean checkout of `main`:

```sh
node --version
pnpm --version
npm install --global npm@12.0.2
npm --version
git status --short
pnpm install --frozen-lockfile
pnpm release:check
```

`release:check` runs the TypeScript 7 build, package Poku suites, coverage gates, contract/tarball
checks, and both real-database packed consumers. It requires Docker or Podman.

Before publishing, confirm all required checks are green on the exact commit:

- `quality`
- `postgres-e2e`
- `mysql-e2e`
- `packed-real-databases`
- `editor-artifacts`

## Phase 2: npm organization and authentication

Create or verify the npm organization whose scope is `@typed-sql`. The authenticated maintainer must
be an owner of that organization and must have 2FA enabled.

```sh
npm login
npm whoami
npm org ls typed-sql
```

Every first publication must be public and use the prerelease tag:

```sh
npm publish --access public --tag next
```

Always request `next` for beta publications. Do not intentionally promote a later beta to `latest`.

## Phase 3: first registry bootstrap

npm trusted publishers can only be configured for packages that already exist. Bootstrap the first
beta interactively in dependency order from the exact verified commit.

Dry-run and inspect all artifacts first:

```sh
pnpm release:artifacts
```

Publish one package at a time in this order:

```sh
pnpm --filter @typed-sql/core publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/ast publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/schema publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/config publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/compiler publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/postgres publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/mysql publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/ts-bridge publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/cli publish --access public --tag next --no-git-checks
pnpm --filter @typed-sql/language-server publish --access public --tag next --no-git-checks
```

The bootstrap runs on a maintainer machine. `1.0.0-beta.0` reserves and proves the package graph but
will not carry a provenance attestation. Do not set `publishConfig.provenance`: current npm trusted
publishing generates provenance automatically in GitHub Actions, while forcing it locally makes npm
attempt unsupported local provenance generation. The next OIDC release will carry the attestation.

For a package's first-ever version, npm may create both `next` and the required initial `latest` tag
even though the publish command specifies `--tag next`. When no alternative version exists, npm
rejects removal of that sole `latest` tag with HTTP 400. Record the bootstrap state and leave both
tags on `1.0.0-beta.0`; subsequent beta releases move only `next`, and stable `1.0.0` replaces
`latest`.

If a command fails, inspect the error and resume with that package. Never bump or republish packages
that succeeded: an npm name/version pair is immutable.

Verify the registry state:

```sh
npm view @typed-sql/core dist-tags versions
npm view @typed-sql/postgres dist-tags versions dependencies
npm view @typed-sql/mysql dist-tags versions dependencies
npm view @typed-sql/language-server dist-tags versions dependencies
```

## Phase 4: configure trusted publishing

Use npm `11.15.0` or newer and authenticate interactively. Node `24.10.0` can use npm `11.19.0`;
npm `12.0.2` requires Node `24.15.0` or newer. Create the same trust relationship for each package.
The trusted publisher values are:

- GitHub owner: `Lojhan`
- repository: `typed-sql`
- workflow file: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

The CLI form is:

```sh
npm trust github @typed-sql/core \
  --repo Lojhan/typed-sql \
  --file release.yml \
  --env npm \
  --allow-publish \
  --yes
```

Repeat it for every package in `release-manifest.json`. npm may offer a short 2FA grace window for
the remaining commands after the first challenge.

After OIDC is proven, set each package's publishing access to require 2FA and disallow traditional
tokens. Revoke any temporary granular token used for bootstrap.

## Phase 5: prove OIDC and provenance

Create a patch changeset for all ten public packages with the summary `Prove npm trusted publishing
after the initial registry bootstrap`, merge it, and merge the resulting Version Packages PR. It
should produce `1.0.0-beta.1`.

Dispatch the Release workflow with channel `beta`. The workflow must authenticate only through
OIDC, publish under `next`, create Git tags and GitHub releases, and attach npm provenance. Confirm:

Changesets normally requires its prerelease identifier (`beta`) to also be the npm dist-tag. The
repository therefore uses Changesets for versioning, changelogs, and release tags, but publishes the
registry graph through a small manifest-driven adapter. It publishes each package in
`release-manifest.json` order under `next`, permits independently versioned packages, skips exact
versions already present on npm so a failed run can be retried safely, and creates tags only after
the entire graph succeeds. pnpm packs each workspace package so `workspace:` ranges are resolved,
then npm 12 publishes that immutable tarball through its native OIDC exchange. The workflow
deliberately omits setup-node's `registry-url` option so its generated token placeholder cannot
suppress that exchange.

```sh
npm view @typed-sql/core@next version dist.tarball
npm view @typed-sql/language-server@next version dist.tarball
```

Both versions must be `1.0.0-beta.1`. Check each npm page for its provenance link to the exact
Release workflow run before restricting traditional token access.

## Phase 6: verify the registry like a user

The tarball E2E is necessary, but the first publication must also prove npm resolution. In a new
directory with no workspace links or overrides:

```sh
pnpm init
pnpm add @typed-sql/core@next @typed-sql/postgres@next pg
pnpm add @typed-sql/mysql@next mysql2
pnpm add -D @typed-sql/cli@next @typed-sql/language-server@next typescript@7.0.2
```

Re-run the PostgreSQL and MySQL playground flows against these registry dependencies. Verify:

- generation from a live catalog;
- exact TypeScript 7.0 query and downstream row types;
- TypeScript 7.1 preview hover through the language server;
- runtime execution through application-owned `pg` and `mysql2`;
- clean and failing drift paths;
- `pg` is absent when only the PostgreSQL grammar is installed, and likewise for `mysql2`;
- every npm page renders its package README;
- the installed `next` versions display provenance from the protected Release workflow.

## Routine beta releases

The repository is in Changesets prerelease mode with the `beta` tag. For a user-visible change:

```sh
pnpm changeset
```

Merge the change and then the generated Version Packages PR. Dispatch the protected Release
workflow with channel `beta`. It reruns the full release gate and publishes with npm OIDC under
`next`.

## Stable 1.0 exit

Do not exit prerelease mode until the beta acceptance criteria are met:

- registry installs work without overrides;
- at least three independent projects have exercised typed queries;
- PostgreSQL and MySQL E2E remain green for the full soak period;
- Zed and VS Code installation paths are documented and reproducible;
- no open correctness issue can produce a confidently wrong row type;
- all intended 1.0 public APIs and diagnostics have completed final review.

Then create a dedicated release PR:

```sh
pnpm changeset pre exit
pnpm version-packages
```

The PR must change every public package to stable `1.0.0`, update internal dependency versions,
remove prerelease state, and update changelogs. After CI is green and the PR is merged, dispatch the
Release workflow with channel `stable`. Confirm `latest` points to `1.0.0` while `next` remains on
the last beta or is updated intentionally.

## Recovery rules

- Never delete or force-move a published npm version.
- Never publish a beta under `latest`.
- Never rerun a partially successful bootstrap as a recursive publish; resume package by package.
- Never dispatch from a branch other than protected `main`.
- If OIDC authentication fails, verify the case-sensitive owner, repository, workflow filename, and
  environment before considering any token fallback.
- If package contents are wrong, publish a new beta version. npm versions are immutable.

The general development release policy remains in [`RELEASING.md`](./RELEASING.md).
