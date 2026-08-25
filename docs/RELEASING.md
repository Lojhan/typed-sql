# Releasing

typed-sql uses Changesets to version independently published packages under the `@typed-sql` scope.
The current channel and version are declared in [`release-manifest.json`](../release-manifest.json).
The complete one-time npm bootstrap and stable-promotion procedure is in
[`PUBLISHING.md`](./PUBLISHING.md).

## Change flow

1. Add a package-scoped changeset with `pnpm changeset` for every user-visible change.
2. Merge the change to `main`.
3. Review and merge the Version Packages PR created by `release.yml`.
4. Wait for all required CI checks on the exact version commit.
5. Dispatch the protected Release workflow with the channel matching the version:
   - `beta` for `1.0.0-beta.*`, published under `next`;
   - `stable` only after prerelease mode has been exited, published under `latest`.

The version job has no npm/OIDC authority. The publish job runs on a GitHub-hosted runner, has
`id-token: write`, is restricted to protected `main`, and requires approval through the `npm`
environment.

## Required gates

Publishing is blocked unless all of these pass:

- TypeScript 7 typecheck and build;
- package-owned Poku suites;
- 95% statement/line/function and 90% branch coverage for compiler-critical packages;
- forbidden-driver and grammar-neutral dependency contracts;
- public tarballs containing compiled output, declarations, README, LICENSE, and CHANGELOG;
- isolated tarball installation without database drivers;
- real PostgreSQL and MySQL generation, inference, execution, and drift flows;
- packed real-database consumers with no workspace links;
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

Beta registry publication is intentionally separate from Changesets' prerelease publish planner.
The planner cannot represent `-beta.N` versions published under the independent `next` dist-tag.
`release:beta` instead follows `release-manifest.json` deterministically, checks npm before every
write for retry safety, packs workspace-resolved tarballs with pnpm, publishes them through npm's
native OIDC client, and asks Changesets to create tags only after every package is published.

After trusted publishing is operational, package settings should require 2FA and disallow
traditional tokens. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).
