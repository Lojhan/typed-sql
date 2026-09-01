---
title: Grammar support
description: Version policy and exact, conservative, unsupported, or out-of-scope status for typed-sql grammar features.
---

# Grammar support

typed-sql classifies its application-query surface explicitly. `exact` means row types, ordered parameters, diagnostics, and relevant semantics are proven by executable tests. `conservative` means uncertain results remain `unknown`. `unsupported` and `out-of-scope` features fail closed instead of receiving optimistic inference.

The ranges below describe supported language lines. Exact server patches exercised by release CI are recorded separately from these ranges; an unrecognized future version remains conservative until its behavior is classified.

## Version policy

| Grammar | Stable range or lines | Canary range or lines |
| --- | --- | --- |
| MySQL | 8.4, 9.7 | 26.7 |
| PostgreSQL | 14, 15, 16, 17, 18 | 19 |
| SQLite | 3.39.0–3.53.4 | 3.54.0 |

## Feature classifications

| Feature | Category | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- | --- |
| `expression.aggregate.filter` — Aggregate FILTER clause | clause | unsupported | exact | exact (from 3.30.0) |
| `expression.aggregate.within-group` — Ordered-set aggregate WITHIN GROUP syntax | clause | unsupported | exact | unsupported |
| `expression.array.constructor` — Array constructor and expressions | expression | unsupported | exact | unsupported |
| `expression.array.subscript` — PostgreSQL array subscripts and slices | expression | unsupported | exact | unsupported |
| `expression.at-local` — PostgreSQL AT LOCAL conversion | expression | unsupported | exact (from 17) | unsupported |
| `expression.at-time-zone` — PostgreSQL AT TIME ZONE conversion | expression | unsupported | exact | unsupported |
| `expression.cast` — CAST expressions and type names | expression | exact | exact | exact |
| `expression.collate` — Explicit expression collation | expression | unsupported | conservative | unsupported |
| `expression.composite-field` — PostgreSQL composite field selection | expression | unsupported | exact | unsupported |
| `expression.function.call` — Catalog and application function calls | function-family | conservative | conservative | conservative (from 3.39.0) |
| `expression.function.date-time` — SQLite date and time functions and modifiers | function-family | out-of-scope | out-of-scope | exact (from 3.39.0) |
| `expression.function.json` — SQLite JSON and JSONB scalar, aggregate, operator, and table functions | function-family | out-of-scope | out-of-scope | exact (from 3.39.0) |
| `expression.function.math-extensions` — SQLite compile-option math and extension functions | function-family | out-of-scope | out-of-scope | exact (from 3.39.0) |
| `expression.function.registry` — SQLite application-defined scalar, aggregate, and window routine registry | function-family | out-of-scope | out-of-scope | exact (from 3.39.0) |
| `expression.interval-literal` — PostgreSQL interval literals and field qualifiers | expression | unsupported | exact | unsupported |
| `expression.json-path` — PostgreSQL JSON-path literals, operators, and core routines | expression | unsupported | exact | unsupported |
| `expression.operator` — Unary and binary operators | operator | conservative | conservative | conservative (from 3.39.0) |
| `expression.quantified-comparison` — ANY, SOME, and ALL comparisons | expression | conservative | exact | unsupported |
| `expression.row-comparison` — Row constructor comparisons | expression | conservative | exact | conservative |
| `expression.scalar` — Columns, stars, literals, and parameters | expression | exact | exact | exact |
| `expression.sql-json-exists` — PostgreSQL SQL/JSON JSON_EXISTS expression | expression | unsupported | exact (from 17) | unsupported |
| `expression.structured` — Row, CASE, predicate, and subquery expressions | expression | exact | exact | exact |
| `lexical.structure` — Identifiers, literals, comments, parameters, tokens, and source ranges | lexical | conservative | exact | conservative |
| `query.cte` — Ordinary common table expressions | clause | exact (from 8.0.1) | exact (from 8.4) | exact (from 3.8.3) |
| `query.distinct` — DISTINCT and ALL projection modifiers | clause | exact | exact | exact |
| `query.distinct-on` — DISTINCT ON | clause | unsupported | exact | unsupported |
| `query.grouping` — GROUP BY, HAVING, grouping sets, ROLLUP, and CUBE | clause | exact | exact | exact |
| `query.join` — Named, cross, inner, and outer joins | clause | exact | exact | exact |
| `query.join.full` — FULL OUTER JOIN | clause | unsupported | exact | exact (from 3.39.0) |
| `query.locking.read` — Locking read clauses | clause | exact | exact | unsupported |
| `query.ordering-pagination` — Ordering, limiting, and offsetting rows | clause | exact | exact | exact |
| `query.projection` — Projection items, aliases, and output naming | clause | exact | exact | exact |
| `query.relation` — Named tables and derived table references | clause | exact | exact | exact |
| `query.relation.derived-alias-optional` — PostgreSQL unaliased derived tables | clause | unsupported | exact (from 16) | out-of-scope |
| `query.relation.function` — Function calls as table relations | clause | unsupported | exact | exact |
| `query.relation.lateral` — LATERAL derived tables | clause | exact (from 8.0.14) | exact (from 9.3) | unsupported |
| `query.relation.rows-from` — PostgreSQL ROWS FROM and WITH ORDINALITY | clause | unsupported | exact | unsupported |
| `query.relation.table-sample` — PostgreSQL TABLESAMPLE and REPEATABLE | clause | unsupported | exact | unsupported |
| `query.set-operation` — Set operations | clause | unsupported | exact | exact |
| `query.window` — Named and inline window specifications | clause | exact (from 8.0) | exact (from 8.4) | exact (from 3.25.0) |
| `query.with.recursive` — Recursive common table expressions | clause | unsupported (from 8.0.1) | exact (from 8.4) | exact (from 3.8.3) |
| `query.with.search-cycle` — Recursive CTE SEARCH and CYCLE clauses | clause | unsupported | exact (from 14) | unsupported |
| `resolver.catalog` — Catalog name, type, coercion, and nullability resolution | coercion | conservative | conservative | conservative (from 3.39.0) |
| `runtime.bulk-transfer` — Native bulk import and export capabilities | runtime | exact | exact | unsupported |
| `runtime.codec-policy` — Compile-time and runtime type codec policy | runtime | exact | exact | exact |
| `runtime.execution` — Buffered, prepared, batched, and transactional execution | runtime | exact | exact | exact |
| `runtime.execution-control` — Cancellation signals and absolute deadlines | runtime | exact | exact | unsupported |
| `runtime.introspection` — Schema and server-evidence introspection | schema | exact | exact | exact (from 3.39.0) |
| `runtime.pipeline.postgres` — PostgreSQL protocol pipeline execution | runtime | out-of-scope | exact | out-of-scope |
| `runtime.streaming` — Bounded asynchronous row streaming | runtime | exact | exact | exact |
| `runtime.verification-and-plans` — Live metadata verification and query-plan inspection | runtime | exact | exact | unsupported |
| `schema.column.generated-assignment` — Generated-column insert and update restrictions | schema | conservative | conservative | exact |
| `schema.sqlite.structural-evidence` — SQLite rowid, generated, virtual, index, constraint, and attached-database evidence | schema | out-of-scope | out-of-scope | exact (from 3.39.0) |
| `schema.table.strict` — STRICT tables | type-family | out-of-scope | out-of-scope | exact (from 3.37.0) |
| `semantic.query-evidence` — Operation, dependency, cardinality, volatility, locking, and affinity evidence | semantic | conservative | conservative | conservative |
| `statement.cte.data-modifying` — Data-modifying statements in common table expressions | statement | conservative | exact | unsupported |
| `statement.delete` — DELETE statements | statement | exact | exact | exact |
| `statement.dml.delete-using` — DELETE USING source relations | clause | exact | exact | unsupported |
| `statement.dml.positioned-update-delete` — PostgreSQL positioned UPDATE and DELETE | clause | unsupported | exact | unsupported |
| `statement.dml.returning` — DML RETURNING clause | clause | unsupported | exact | exact (from 3.35.0) |
| `statement.dml.returning-old-new` — PostgreSQL OLD and NEW RETURNING namespaces | clause | unsupported | exact (from 18) | unsupported |
| `statement.dml.update-from` — UPDATE FROM source relations | clause | unsupported | exact | exact (from 3.33.0) |
| `statement.insert` — INSERT statements and multi-row VALUES sources | statement | exact | exact | exact |
| `statement.insert.conflict` — INSERT conflict handling and UPSERT clauses | clause | unsupported | exact (from 9.5) | exact (from 3.24.0) |
| `statement.insert.default-values` — INSERT DEFAULT VALUES | clause | unsupported | exact | exact |
| `statement.insert.identity-overriding` — INSERT identity OVERRIDING clauses | clause | unsupported | exact | unsupported |
| `statement.merge` — Versioned PostgreSQL MERGE statements | statement | unsupported | exact (from 15) | unsupported |
| `statement.out-of-scope.commands` — Administrative, replication, maintenance, and procedural commands | statement | out-of-scope | out-of-scope | out-of-scope |
| `statement.select` — SELECT statements | statement | exact | exact | exact |
| `statement.update` — UPDATE statements and assignments | statement | exact | exact | exact |
| `tooling.compiler.artifacts` — Static extraction, generated declarations, and query manifests | tooling | exact | exact | exact |
| `tooling.diagnostics` — Stable diagnostics, suggestions, and source spans | tooling | exact | exact | exact |
| `tooling.editor.integration` — TypeScript preview bridge and language-server analysis | tooling | conservative | conservative | conservative |
| `tooling.parser.resource-limits` — Bounded SQL length, token count, and parse depth | tooling | exact | exact | exact |
| `tooling.structural-sql` — Explicit structural SQL and parameter-safe composition | tooling | exact | exact | exact |

Administrative, replication, maintenance, and procedural command languages are outside the application-query contract. They receive syntax, unsupported, or dynamic-query diagnostics when encountered through static analysis.

This page is generated from `grammar/features/ledger.json`. Update the ledger, its executable evidence, and this page together.
