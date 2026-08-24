# Contributing

typed-sql is a TypeScript 7 SQL compiler. Issues and focused pull requests are
welcome, especially when accompanied by a reduced SQL/schema fixture.

## Development

Requirements:

- Node.js 22.11 or newer;
- pnpm 10.32.1;
- Podman or Docker for the PostgreSQL, MySQL, and packed-consumer E2E suites.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm coverage
pnpm test:pack
```

Run the real database flow with:

```sh
TYPED_SQL_CONTAINER_ENGINE=docker pnpm e2e:postgres
TYPED_SQL_CONTAINER_ENGINE=docker pnpm e2e:mysql
TYPED_SQL_CONTAINER_ENGINE=docker pnpm e2e:packed
```

Tests use Poku and are ordinary TypeScript programs. Add compiler behavior as a focused fixture and
assert both the inferred type and diagnostics. Unsupported or dynamic SQL must resolve to
`Query<unknown>` rather than `any` or an optimistic inferred type.

Tests belong to the package that owns the behavior. Compiler-critical packages enforce 95% line,
statement, and function coverage plus 90% branch coverage with the official Poku c8 integration.
Changes to package boundaries must keep the packed-consumer and forbidden-driver contracts green.

## Changes and releases

User-visible package changes should include a Changeset:

```sh
pnpm changeset
```

Use semantic versioning. The stable 1.x contracts require a major bump for breaking changes.
Commits should be small enough to review and must not contain database credentials,
packet captures, generated build output, or unrelated formatting changes.

By contributing, you agree that your contribution is licensed under the MIT License.
