# Releasing

typed-sql uses Changesets to version independently published packages under the `@typed-sql` scope.
The current channel and version are declared in [`release-manifest.json`](../release-manifest.json).
Its `packagePolicy` separates the stable package train from preview-backed experimental tooling.
Every public package repeats that value as `typedSql.releaseTrack` in its packed manifest.

## Change flow

1. Add a package-scoped changeset with `pnpm changeset` for every user-visible change.
2. Merge the change to `main`.
3. Review and merge the Version Packages PR created by `release.yml`.
4. Wait for all required CI checks on the exact version commit.
5. Dispatch the protected Release workflow with the channel matching the version:
   - `beta` for `1.0.0-beta.*`, published under `next`;
   - `stable` only after prerelease mode has been exited, published under `latest`.

Before creating the stable version PR, run the isolated, no-write rehearsal documented in
[`STABLE_REHEARSAL.md`](./STABLE_REHEARSAL.md):

```sh
TYPED_SQL_CONTAINER_ENGINE=podman pnpm release:rehearse
```

The version job has no npm/OIDC authority. The publish job runs on a GitHub-hosted runner, has
`id-token: write`, is restricted to protected `main`, and requires approval through the `npm`
environment.

## Required gates

Publishing is blocked unless all of these pass:

- TypeScript 7 typecheck and build;
- deterministic Biome formatting and linting;
- package-owned Poku suites;
- 95% statement/line/function and 90% branch coverage for compiler-critical packages;
- forbidden-driver and grammar-neutral dependency contracts;
- public tarballs containing compiled output, declarations, README, LICENSE, and CHANGELOG;
- clean-build output whose emitted JavaScript modules exactly match current source modules;
- isolated tarball installation without database drivers;
- real PostgreSQL and MySQL generation, inference, execution, and drift flows;
- packed real-database consumers with no workspace links;
- registry-only PostgreSQL and MySQL consumers installed from npm `next`, with no checkout
  resolution or implicit drivers;
- no open critical- or high-severity CodeQL alert;
- production dependency audit with no high-severity advisory.

## Trusted publishing

Every package trusts the same GitHub Actions identity:

- owner: `Lojhan`
- repository: `typed-sql`
- workflow: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

The release job uses Node 24 and npm 12.0.2. OIDC creates short-lived credentials and npm
attaches provenance because both repository and packages are public. No long-lived npm token belongs
in GitHub or the repository.

Registry publication is intentionally separate from Changesets' publish planner.
The planner cannot represent `-beta.N` versions published under the independent `next` dist-tag.
`release:beta` instead follows `release-manifest.json` deterministically, checks npm before every
write for retry safety, supports independently versioned packages in the same release graph, packs
workspace-resolved tarballs with pnpm, publishes them through npm's native OIDC client, and asks
Changesets to create tags only after every package is published. Stable uses the same retry-safe
publisher, restricted to the stable package train and the `latest` tag.

After trusted publishing is operational, package settings should require 2FA and disallow
traditional tokens. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## Stable promotion

Do not promote `latest` until registry installs work without workspace overrides, PostgreSQL and
MySQL packed E2E remain green through the beta soak, editor installation has been exercised outside
this repository, and no open correctness issue can produce a confidently wrong row type.

Create the dedicated release PR from `artifacts/stable-rehearsal/stable-release.diff`. It sets the
packages in `packagePolicy.stable` to stable `1.0.0`, keeps `packagePolicy.experimental` on explicit
prerelease versions with their pending Changesets intact, updates internal ranges, removes the
stable train's prerelease state, and updates stable changelogs. Stable assertions reject
experimental packages in the `latest` publication set. After protected CI passes and the PR merges,
dispatch the Release workflow with channel `stable` and confirm `latest` points to `1.0.0` only for
the stable train.

## Recovery rules

- Never delete or move a published npm version or release tag.
- Never publish a beta under `latest`.
- Retry partial beta releases normally: the publisher skips exact versions already present on npm.
- Dispatch releases only from protected `main`.
- If OIDC fails, verify the case-sensitive owner, repository, workflow and environment before
  considering any token fallback.
- If package contents are wrong, publish a new version; npm versions are immutable.
