# typed-sql examples

These private workspace packages exercise the same public APIs that an application installs from
npm. Their `workspace:*` dependencies always resolve to the currently checked-out branch.

| Example | Grammar | Application-owned driver | Database |
| --- | --- | --- | --- |
| [`postgres`](./postgres/README.md) | `@typed-sql/postgres` | `pg` | pinned PostgreSQL container |
| [`mysql`](./mysql/README.md) | `@typed-sql/mysql` | `mysql2` | pinned MySQL container |
| [`sqlite`](./sqlite/README.md) | `@typed-sql/sqlite` | Node `node:sqlite` | local SQLite file |
| [`synthetic-grammar`](./synthetic-grammar/README.md) | third-party proof | none | in-memory snapshot |

Each database example keeps its schema, typed-sql config, queries, driver integration, and Poku
tests together. The tests only verify query construction and rendering, so the normal repository
test suite does not require running services. Follow an example README to execute it against a real
database.

The canonical, rendered walkthroughs live in the [examples documentation](../docs/examples/index.md).
