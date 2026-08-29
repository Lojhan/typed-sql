---
title: Examples
description: Run maintained typed-sql applications for PostgreSQL, MySQL, SQLite, or a third-party grammar.
---

# Examples

The repository includes complete application packages that use typed-sql through its public entrypoints. Their
workspace dependencies resolve to the current source tree, while each database driver remains an explicit
application dependency.

| Example | Driver capabilities exercised | Database setup |
| --- | --- | --- |
| [PostgreSQL](./postgresql.md) | Queries, mutations, transactions, prepared queries, cursors, pipelines, COPY, cancellation, routing, observation, validation | Pinned PostgreSQL container |
| [MySQL](./mysql.md) | Queries, mutations, transactions, prepared queries, streams, `LOAD DATA`, cancellation, routing, observation, validation | Pinned MySQL container |
| [SQLite](./sqlite.md) | Queries, mutations, transactions, prepared queries, streams, small batches, validation, explicit capability discovery | Recreated local database file |
| [Custom grammar](../extending/custom-grammars.md) | A third-party grammar using only published contracts | In-memory conformance fixture |

Each database example contains its schema, typed-sql config, generated snapshot, focused capability modules,
adapter execution, service-free Poku tests, and a Poku suite that runs against the real driver. The checked-in
generated snapshot enables editor inference as soon as the workspace opens.

## Run an example from the repository

Install and build the current source tree first:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Run every example through generation, analysis, its executable entrypoint, and its real database suite:

```sh
pnpm e2e:examples
```

Pass `postgres`, `mysql`, or `sqlite` to `node examples/e2e.mjs` to run one example. Set
`TYPED_SQL_CONTAINER_ENGINE=podman` to use Podman for the container-backed examples. PostgreSQL and MySQL
containers are always removed in a `finally` path. SQLite uses a recreated local file.

The normal `pnpm test` gate keeps a service-free construction suite for each example. CI also runs the real
database suites as a protected three-entry matrix, so the documented adapter paths are executable rather than
illustrative snippets.

Applications outside this repository install released package versions rather than `workspace:*`. The source
code and API usage are otherwise the same.

To inspect exact hovers in Zed, install the development extension once and open a database example directory as
its own workspace, such as `zed examples/postgres`. Each example includes a matching `.zed/settings.json` and
the language server as a workspace development dependency. See [Editor setup](../guides/editors.md) for the
extension and other clients.
