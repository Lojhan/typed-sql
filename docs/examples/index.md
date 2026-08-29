---
title: Examples
description: Run maintained typed-sql applications for PostgreSQL, MySQL, SQLite, or a third-party grammar.
---

# Examples

The repository includes complete application packages that use typed-sql through its public entrypoints. Their
workspace dependencies resolve to the current source tree, while each database driver remains an explicit
application dependency.

| Example | What it demonstrates | Database setup |
| --- | --- | --- |
| [PostgreSQL](./postgresql.md) | Conditional selection and filters, `pg`, exact ordered parameters | Pinned PostgreSQL container |
| [MySQL](./mysql.md) | The same grammar-neutral application shape with `mysql2` | Pinned MySQL container |
| [SQLite](./sqlite.md) | The same query primitives with Node's built-in SQLite adapter | Recreated local database file |
| [Custom grammar](../extending/custom-grammars.md) | A third-party grammar using only published contracts | In-memory conformance fixture |

Each database example contains its schema, typed-sql config, generated snapshot, queries, adapter execution,
and Poku tests. The checked-in generated snapshot enables editor inference as soon as the workspace opens.

## Run an example from the repository

Install and build the current source tree first:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Then follow the dialect page. PostgreSQL and MySQL use a container only for generation and execution. Their
Poku tests validate structural composition, placeholders, and ordered values without connecting to a database.
The SQLite example is entirely local.

Applications outside this repository install released package versions rather than `workspace:*`. The source
code and API usage are otherwise the same.

To inspect exact hovers in Zed, install the development extension once and open a database example directory as
its own workspace, such as `zed examples/postgres`. Each example includes a matching `.zed/settings.json` and
the language server as a workspace development dependency. See [Editor setup](../guides/editors.md) for the
extension and other clients.
