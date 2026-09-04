---
title: Get started
description: Choose PostgreSQL, MySQL, or SQLite and follow the shortest path from schema evidence to a checked, executed query.
pageType: landing
---

# Get started

Choose the database your application already uses. Each quickstart creates one table, generates a
schema snapshot, proves an exact query contract with the stable compiler, and executes through an
explicitly selected driver adapter.

<StepFlow
  label="The typed-sql development loop"
  :steps="['Database schema', 'Schema snapshot', 'SQL template', 'Compiler check', 'Driver execution']"
/>

The snapshot is compiler input. Application code imports `sql` from its grammar package and keeps
connection, pool, migration, and lifecycle ownership.

## Choose a database

<DialectCards>
  <article class="ts-dialect-card">
    <StatusBadge status="stable" />
    <h3>PostgreSQL</h3>
    <p><code>@typed-sql/postgres</code> plus an application-owned <code>pg</code> driver. Requires an accessible PostgreSQL database.</p>
    <a href="./postgresql">Open the PostgreSQL quickstart <span aria-hidden="true">→</span></a>
  </article>
  <article class="ts-dialect-card">
    <StatusBadge status="stable" />
    <h3>MySQL</h3>
    <p><code>@typed-sql/mysql</code> plus an application-owned <code>mysql2</code> driver. Requires an accessible MySQL database.</p>
    <a href="./mysql">Open the MySQL quickstart <span aria-hidden="true">→</span></a>
  </article>
  <article class="ts-dialect-card">
    <StatusBadge status="stable" />
    <h3>SQLite</h3>
    <p><code>@typed-sql/sqlite</code> with Node's built-in driver. The quickstart creates a local file and needs no server.</p>
    <a href="./sqlite">Open the SQLite quickstart <span aria-hidden="true">→</span></a>
  </article>
</DialectCards>

All three grammar packages are stable. Their supported database ranges and exact verification
targets differ, so each path links its dialect evidence before setup.

## What every path establishes

1. Install one grammar and explicitly select its driver or built-in runtime.
2. Create the smallest configuration needed for introspection and checking.
3. Generate deterministic schema evidence.
4. Write SQL with values represented as parameters.
5. Run `typed-sql check` and inspect the exact row and ordered parameter tuple.
6. Execute the same query object without moving connection ownership into typed-sql.
7. Confirm that an invalid parameter is rejected.

This first success does not require manifests, live verification, plan capture, migration analysis,
observability, or editor extensions.

## Stable check, optional editor

`typed-sql check` is the stable, authoritative correctness path. Published declarations fail closed,
so an ordinary TypeScript server can display `Query<unknown>` even after the CLI proves an exact
contract. The optional language server provides richer hovers through an isolated TypeScript preview
process and remains experimental.

Read [Compiler and editor workflow](./compiler-and-editor.md) after completing a dialect quickstart.

## Shared references

- [Choose packages](./installation.md) when adding another dialect or execution capability.
- [Configuration reference](./configuration.md) separates the minimal profile from optional production controls.
- [Query and check loop](./first-query.md) explains the dialect-neutral mechanics.
- [Runnable applications](../examples/index.md) demonstrate broader adapter and grammar behavior.
