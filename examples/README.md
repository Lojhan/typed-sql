# typed-sql examples

These private workspace packages exercise the same public APIs that an application installs from
npm. Their `workspace:*` dependencies always resolve to the currently checked-out branch.

| Example | Grammar | Application-owned driver | Database |
| --- | --- | --- | --- |
| [`postgres`](./postgres/README.md) | `@typed-sql/postgres` | `pg` | pinned PostgreSQL container |
| [`mysql`](./mysql/README.md) | `@typed-sql/mysql` | `mysql2` | pinned MySQL container |
| [`sqlite`](./sqlite/README.md) | `@typed-sql/sqlite` | Node `node:sqlite` | local SQLite file |
| [`synthetic-grammar`](./synthetic-grammar/README.md) | third-party proof | none | in-memory snapshot |

Each database example keeps its schema, typed-sql config, generated snapshot, focused capability
modules, driver integration, service-free Poku tests, and real-database Poku tests together. The
normal repository test suite does not require running services; the protected examples E2E matrix
executes every driver path.

After building the workspace, run all three complete lifecycles with:

```sh
pnpm e2e:examples
```

Use `node examples/e2e.mjs postgres`, `mysql`, or `sqlite` for one package. The lifecycle generates
the schema, checks every source file, runs both test layers, starts the real application, and always
tears down container-backed databases.

The canonical, rendered walkthroughs live in the [examples documentation](../docs/examples/index.md).
