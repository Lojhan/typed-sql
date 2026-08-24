# Releasing

typed-sql uses Changesets and publishes public packages independently under the `@typed-sql`
scope. Version 1.0 freezes the package, schema, diagnostics, and dialect contracts; breaking changes
require a major release.

## Change flow

1. Add a package-scoped changeset with `pnpm changeset`.
2. Merge to `main`. The `release.yml` version job creates or updates the Version Packages PR.
3. Review generated versions/changelogs and merge that PR.
4. Run the protected **Release** workflow manually. It reruns `pnpm verify`, publishes with npm
   trusted publishing, pushes tags, and creates GitHub releases.

The version job has no npm/OIDC authority. The publish job has `id-token: write`, runs only on a
GitHub-hosted runner, and is protected by the `npm` GitHub environment.

## npm trusted publisher setup

For every public package, configure the npm trusted publisher with:

- owner: `Lojhan`;
- repository: `typed-sql`;
- workflow filename: `release.yml`;
- environment: `npm`;
- allowed action: `npm publish`.

The workflow uses Node 24 and npm 11.5.1 because current npm trusted publishing requires Node
22.14+ and npm 11.5.1+. No long-lived npm token is configured. Trusted GitHub publishing adds
provenance automatically for public packages from a public repository.

An npm package must exist before its trusted publisher can be configured. Bootstrap each package
once from a maintainer machine with short-lived interactive authentication, then configure OIDC
before using the workflow. After OIDC succeeds, disallow automation tokens in npm package settings.

References: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and
[Changesets publish action](https://github.com/changesets/action/blob/main/publish/README.md).

## Release gates

Publishing is blocked unless all of these pass:

- TypeScript 7 typecheck/build;
- package-owned Poku suites;
- 95% statement/line/function and 90% branch coverage for gated compiler-critical packages;
- forbidden-driver and grammar-neutral dependency contracts;
- all public tarballs pack cleanly and install in an isolated no-driver consumer;
- real PostgreSQL and MySQL container generation, execution, and drift flows in CI.
