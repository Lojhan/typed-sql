# Registry-only acceptance

The registry acceptance suite is the final consumer boundary before stable promotion. It reuses the
same real PostgreSQL and MySQL fixture as the packed-artifact E2E, but every `@typed-sql/*` package is
resolved from npm instead of the checkout.

Run it with Node.js 22.11 or newer, pnpm 10.32.1, and Docker or Podman available:

```sh
TYPED_SQL_CONTAINER_ENGINE=podman pnpm e2e:registry
```

The command creates a disposable project with no lockfile or `node_modules`, installs
`@typed-sql/*@next` and the explicitly selected `pg`/`mysql2` drivers, provisions both databases,
introspects fresh schemas, and then verifies:

- the manifest, new lockfile, and resolved package paths contain no workspace, link, file, tarball,
  or repository source;
- no typed-sql package installs a database driver transitively;
- exact rows and ordered parameters for joins, nullable relations, enums, CTEs, catalog functions,
  conditional projections, and optional filters;
- literal `status: false`, literal `status: true`, and runtime-boolean result shapes;
- TypeScript 7.0 compiler checks and TypeScript 7.1 preview inspection;
- startup and exact hover output from the installed language-server executable;
- runtime execution through application-owned `pg` and `mysql2`;
- the static response type and runtime JSON of `GET /dashboard`;
- PostgreSQL and MySQL drift checks;
- container and temporary-directory cleanup even after failure.

Set `TYPED_SQL_REGISTRY_TAG` to exercise an explicit prerelease tag such as `next`. The protected
stable Release workflow always runs this suite against `next` before it can publish `latest`, so the
candidate being promoted has already passed outside the monorepo package graph.

The ordinary `pnpm e2e:packed` gate remains separate: it validates the artifacts built by the
current commit before they exist on npm. Both gates use the same test implementation to prevent the
registry scenario from drifting into a second example application.
