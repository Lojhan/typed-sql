# Contributing

typed-sql is an experimental TypeScript 7 SQL compiler. Issues and focused pull requests are
welcome, especially when accompanied by a reduced SQL/schema fixture.

## Development

Requirements:

- Node.js 22.11 or newer;
- pnpm 10.32.1;
- Podman or Docker for the live PostgreSQL E2E suite.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Run the real database flow with:

```sh
TYPED_SQL_CONTAINER_ENGINE=docker pnpm e2e:postgres
```

Tests use Poku and are ordinary TypeScript programs. Add compiler behavior as a focused fixture and
assert both the inferred type and diagnostics. Unsupported or dynamic SQL must resolve to
`Query<unknown>` rather than `any` or an optimistic inferred type.

## Changes and releases

User-visible package changes should include a Changeset:

```sh
pnpm changeset
```

Use semantic versioning. Before 1.0, breaking changes require a minor bump; after 1.0 they require a
major bump. Commits should be small enough to review and must not contain database credentials,
packet captures, generated build output, or unrelated formatting changes.

By contributing, you agree that your contribution is licensed under the MIT License.
