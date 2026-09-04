---
title: typed-sql
description: Write SQL and get exact TypeScript row and parameter contracts from a checked database schema while keeping your driver and database architecture.
pageType: landing
sidebar: false
aside: false
outline: false
---

<HomeHero>
<template #copy>

# Write SQL. Read TypeScript. {#typed-sql-home-title}

typed-sql analyzes static SQL against your schema. Keep your application-owned driver and SQL architecture—without adopting an ORM or model layer.

<p class="ts-home-actions">
  <a class="ts-button ts-button--primary" href="./getting-started/">Get started</a>
  <a class="ts-button ts-button--secondary" href="#how-it-works">See how it works</a>
  <a class="ts-button ts-button--text" href="https://github.com/Lojhan/typed-sql">View on GitHub <span aria-hidden="true">↗</span></a>
</p>

<p class="ts-home-boundary"><strong>Stable compiler path.</strong> Exact editor hovers use optional experimental tooling.</p>

</template>
<template #demo>

<QueryTypeDemo source-label="Checked query" inspect-target="accountById">
<template #source>

<!-- docs:start homepage-postgres-query -->
```ts
import { sql } from "@typed-sql/postgres";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;
```
<!-- docs:end homepage-postgres-query -->

</template>
<template #result>

<!-- docs:start homepage-postgres-contract -->
```ts
const accountById: Query<
  { "id": bigint; "email": string; "status": "active" | "suspended"; },
  readonly [bigint]
>;
```
<!-- docs:end homepage-postgres-contract -->

</template>
<template #caption>

Checked against the maintained PostgreSQL example schema. The compiler proves a row contract and an ordered parameter tuple; it does not validate rows at runtime unless you add a validator.

</template>
</QueryTypeDemo>

</template>
</HomeHero>

## Try it in your browser

Choose PostgreSQL, MySQL, or SQLite and edit the query. typed-sql runs that grammar's analysis locally; hover
`accountById` to inspect its inferred query type, or hover an adapter result such as `rows` or `rows[0]` to follow
the inferred row into application code. Select a missing column to see an editor diagnostic. The
**Schemas** control opens the shared browser workspace. Changes made there apply to every live example on the site
and remain in this browser until you restore the defaults.

<SqlPlayground />

## SQL in, exact contract out {#how-it-works}

The selected grammar resolves SQL syntax, names, database types, nullability, and parameter positions.
Supported static SQL receives an exact contract. Missing evidence remains `unknown`; invalid,
ambiguous, or deliberately unsupported SQL produces a diagnostic instead of a guessed type.

<StepFlow
  label="From database schema to application execution"
  :steps="['Database schema', 'Schema snapshot', 'SQL template', 'Compiler check', 'Driver execution']"
/>

Values remain parameters throughout this path. In the hero query, `accountId` renders as PostgreSQL
placeholder `$1`; the runtime value never becomes SQL text. [Read the inference and safety
boundary](./concepts/type-safety.md).

## Keep your database stack

A grammar package owns SQL analysis, not connections. typed-sql does not install a driver, create a
hidden pool, own migrations, or introduce a model layer. Choose the integration boundary that fits
the application you already have.

<PathCards label="Choose an execution path">
  <a class="ts-path-card" href="./guides/existing-pools">
    <span class="ts-path-card__index">01</span>
    <strong>Keep an existing pool</strong>
    <span>Render the checked query and pass its text and values to the driver you already operate.</span>
  </a>
  <a class="ts-path-card" href="./guides/adapters">
    <span class="ts-path-card__index">02</span>
    <strong>Use a typed-sql adapter</strong>
    <span>Opt into typed execution, decoding, cardinality helpers, streaming, batches, and transactions.</span>
  </a>
</PathCards>

## Composition stays explicit

Ordinary interpolations always become parameters. SQL structure requires a visible API, so code
review can distinguish data from syntax: `sql.fragment` for static structure, `sql.empty` for no
structure, `sql.ident()` for quoted identifiers, and trusted `sql.raw()` for an explicit escape
hatch. [See conditional and repeated composition](./guides/composition.md).

```ts
const query = sql`
  SELECT id, email
  FROM users
  ${includeSuspended ? sql.empty : sql.fragment`WHERE status = ${"active"}`}
`;
```

## Choose your level of adoption

Start with compile-time checking, then add runtime and operational layers only where they solve an
application problem.

<PathCards label="Choose an adoption level">
  <a class="ts-path-card" href="./getting-started/compiler-and-editor">
    <span class="ts-path-card__index">01</span>
    <strong>Compile</strong>
    <span>Generate a snapshot and make <code>typed-sql check</code> authoritative in development and CI.</span>
  </a>
  <a class="ts-path-card" href="./guides/execution">
    <span class="ts-path-card__index">02</span>
    <strong>Execute</strong>
    <span>Keep direct driver calls or adopt an explicit runtime adapter.</span>
  </a>
  <a class="ts-path-card" href="./guides/result-validation">
    <span class="ts-path-card__index">03</span>
    <strong>Validate</strong>
    <span>Attach an application-owned Standard Schema validator at the result boundary.</span>
  </a>
  <a class="ts-path-card" href="./operations/">
    <span class="ts-path-card__index">04</span>
    <strong>Govern</strong>
    <span>Add manifests, live checks, plan review, migration analysis, or observation independently.</span>
  </a>
</PathCards>

## PostgreSQL, MySQL, and SQLite

Each stable grammar owns its language semantics, built-ins, coercions, nullability rules, version
gates, and diagnostics. A supported range is distinct from the exact versions exercised by the
repository.

<DialectCards>
  <article class="ts-dialect-card">
    <StatusBadge status="stable" />
    <h3>PostgreSQL</h3>
    <p>PostgreSQL 14–18 grammar and catalog provider, with an optional adapter for an application-owned <code>pg</code> pool.</p>
    <a href="./dialects/postgresql">PostgreSQL support <span aria-hidden="true">→</span></a>
  </article>
  <article class="ts-dialect-card">
    <StatusBadge status="stable" />
    <h3>MySQL</h3>
    <p>MySQL 8.4 and 9.7 LTS grammar and catalog provider, with an optional adapter for <code>mysql2</code>.</p>
    <a href="./dialects/mysql">MySQL support <span aria-hidden="true">→</span></a>
  </article>
  <article class="ts-dialect-card">
    <StatusBadge status="stable" />
    <h3>SQLite</h3>
    <p>SQLite 3.39.0–3.53.4 grammar and PRAGMA catalog provider, with an optional <code>node:sqlite</code> adapter.</p>
    <a href="./dialects/sqlite">SQLite support <span aria-hidden="true">→</span></a>
  </article>
</DialectCards>

[Compare supported and exactly tested versions](./reference/compatibility.md) or inspect the
generated [grammar support matrix](./reference/grammar-support.md).

## Compared with alternatives

typed-sql fits SQL-first teams that want schema-aware static contracts without moving database
design or connection ownership into a new model layer. Other approaches remain better fits for
different jobs.

| Capability | Raw driver | typed-sql | Query builder | Full ORM |
| --- | --- | --- | --- | --- |
| SQL remains the primary interface | Yes | Yes | Varies | Usually not |
| Schema-aware static row inference | No | Supported static SQL | Library-dependent | Model/query-dependent |
| Runtime driver included | Yes | No | Varies | Usually |
| Dynamic programmatic composition | Application code | Explicit fragments | Core strength | Framework-dependent |
| Relations and unit of work | No | No | Limited or varies | Core strength |
| Migrations included | No | No | Library-dependent | Commonly |

[Understand typed-sql's package and ownership boundaries](./concepts/architecture.md).

## Production controls when needed

The compiler requires a schema snapshot and an authoritative check. Everything below is an optional,
composable control rather than a prerequisite for the first query.

<div class="ts-control-grid">
  <a href="./guides/schema-snapshots"><strong>Snapshot drift</strong><span>Keep compiler evidence aligned with the database.</span></a>
  <a href="./guides/query-manifests"><strong>Query manifests</strong><span>Emit a deterministic, redacted query inventory.</span></a>
  <a href="./guides/live-verification"><strong>Live verification</strong><span>Compare compiler evidence with native database metadata.</span></a>
  <a href="./guides/query-plan-governance"><strong>Plan governance</strong><span>Review redacted structured plans against explicit budgets.</span></a>
  <a href="./guides/migration-compatibility"><strong>Migration compatibility</strong><span>Check both directions of a rolling deployment.</span></a>
  <a href="./guides/observability"><strong>Observation</strong><span>Correlate runtime work without recording SQL or values.</span></a>
</div>

[Choose controls by operational concern](./operations/index.md).

## Evidence and maturity

<ProductStatus>
<template #stable-title>Compiler and database path</template>
<template #stable-description>

Core contracts, schema/configuration, compiler, CLI, PostgreSQL, MySQL, SQLite, conformance, and
OpenTelemetry integration follow the stable package contract.

</template>
<template #experimental-title>Rich editor integration</template>
<template #experimental-description>

The TypeScript preview bridge, language server, and editor distributions remain experimental. The
stable CLI/compiler check is authoritative.

</template>
</ProductStatus>

The repository exercises real database versions, packed consumers, soundness and coverage checks,
and explicit performance budgets. Performance figures are regression guardrails for documented
fixtures—not promises about database latency or application throughput. [Review the workloads,
budgets, and reproducible comparison method](./concepts/performance.md).

## Start with your database

Choose a dialect for the shortest path from schema evidence to a checked query, or begin with a
complete maintained application.

<PathCards label="Start using typed-sql">
  <a class="ts-path-card ts-path-card--primary" href="./getting-started/">
    <strong>Choose PostgreSQL, MySQL, or SQLite</strong>
    <span>Install the grammar and your driver, generate a snapshot, and check the first query.</span>
  </a>
  <a class="ts-path-card" href="./examples/">
    <strong>Explore runnable applications</strong>
    <span>See queries, execution boundaries, and dialect-specific setup in maintained source.</span>
  </a>
</PathCards>
