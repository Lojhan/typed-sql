---
title: Query recipes
description: Find focused typed-sql examples for composition, mutations, execution, validation, bulk transfer, and multiple databases.
pageType: landing
---

# Query recipes

Use these focused paths when you already understand installation and snapshot generation. Every linked
example uses the public grammar API and keeps driver ownership explicit.

## Construct queries

| Task | Example | What it proves |
| --- | --- | --- |
| Select with typed parameters | [Your first query](../getting-started/first-query.md) | Selected row fields and ordered parameters |
| Add optional filters or columns | [Conditional composition](../guides/composition.md#conditional-projections) | Explicit structural branches and result shape |
| Insert several rows from `Array.map` | [Mapped fragment arrays](../guides/composition.md#repeat-homogeneous-fragments) | Automatic comma separation and flattened parameter order |
| Choose mapped arrays or `sql.join()` | [Explicit list controls](../guides/composition.md#handle-empty-input-before-building-sql) | Empty, dynamic, or custom-separator behavior |
| Escape static analysis deliberately | [Dynamic SQL](../guides/composition.md#structural-limits) | Explicit `Query<unknown>` boundary |

## Execute queries

| Task | Example | What it proves |
| --- | --- | --- |
| Execute and assert cardinality | [Execution](../guides/execution.md#assert-cardinality-and-control-execution) | `all`, `one`, `maybeOne`, cancellation, and deadlines |
| Use an existing pool | [Existing pools](../guides/existing-pools.md) | Application lifecycle remains application-owned |
| Prepare repeated query shapes | [Prepared queries](../guides/execution.md#prepare-repeated-queries) | Stable skeleton and bounded cardinality variants |
| Run an ordered batch | [Batches](../guides/execution.md#execute-an-ordered-batch) | One lease, ordered results, and non-atomic default |
| Stream a large result | [Streaming](../guides/execution.md#stream-large-result-sets) | Backpressure and explicit cleanup |
| Validate decoded rows | [Result validation](../guides/result-validation.md) | Standard Schema checks after driver decoding |

## Move data and operate safely

| Task | Example | What it proves |
| --- | --- | --- |
| Choose multi-row SQL, batch, or native bulk | [Bulk data](../guides/bulk-data.md) | Different semantics and protocol capabilities |
| Trace query lifecycle | [Observability](../guides/observability.md) | Neutral events, redaction, and OpenTelemetry |
| Route reads and retry transactions | [Routing and retries](../guides/routing-and-retries.md) | Semantic routing and bounded retry policy |
| Combine PostgreSQL and SQLite | [Multi-database application](./multi-database.md) | Separate grammar, config, evidence, and driver boundaries |

## Complete applications

For setup, generated evidence, runtime behavior, and database-backed tests in one place, use the
[PostgreSQL](./postgresql.md), [MySQL](./mysql.md), [SQLite](./sqlite.md), or
[PostgreSQL plus SQLite](./multi-database.md) application.

The source applications are exercised by the repository's example and real-database test gates. The
pages link to their exact source files rather than presenting generated schema output as an
application-facing API.
