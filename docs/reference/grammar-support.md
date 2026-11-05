---
title: Grammar support
description: Version policy and exact, conservative, unsupported, or out-of-scope status for typed-sql grammar features.
pageType: reference
---

# Grammar support

typed-sql classifies its application-query surface explicitly. `exact` means row types, ordered parameters, diagnostics, and relevant semantics are proven by executable tests. `conservative` means uncertain results remain `unknown`. `unsupported` and `out-of-scope` features fail closed instead of receiving optimistic inference.

The ranges below describe supported language lines. Exact server patches exercised by release CI are recorded separately from these ranges; an unrecognized future version remains conservative until its behavior is classified.

## Version policy

| Grammar | Stable range or lines | Canary range or lines |
| --- | --- | --- |
| DuckDB | 1.5.6, 2.0.0 | None |
| MySQL | 8.4, 9.7 | 26.7 |
| PostgreSQL | 14, 15, 16, 17, 18 | 19 |
| SQLite | 3.39.0–3.54.1 | None |
| SQL Server | 14, 15, 16, 17 | None |

## Feature classifications

| Feature | Category | DuckDB | MySQL | PostgreSQL | SQLite | SQL Server |
| --- | --- | --- | --- | --- | --- | --- |
| `expression.aggregate.filter` — Aggregate FILTER clause | clause | exact | unsupported | exact | exact (from 3.30.0) | unsupported |
| `expression.aggregate.within-group` — Ordered-set aggregate WITHIN GROUP syntax | clause | unsupported | unsupported | exact | unsupported | exact |
| `expression.array.constructor` — Array constructor and expressions | expression | exact | unsupported | exact | unsupported | unsupported |
| `expression.array.subscript` — PostgreSQL array subscripts and slices | expression | exact | unsupported | exact | unsupported | unsupported |
| `expression.at-local` — PostgreSQL AT LOCAL conversion | expression | unsupported | unsupported | exact (from 17) | unsupported | unsupported |
| `expression.at-time-zone` — PostgreSQL AT TIME ZONE conversion | expression | unsupported | unsupported | exact | unsupported | unsupported |
| `expression.cast` — CAST expressions and type names | expression | exact | exact | exact | exact | exact |
| `expression.collate` — Explicit expression collation | expression | unsupported | conservative | conservative | unsupported | conservative |
| `expression.composite-field` — PostgreSQL composite field selection | expression | exact | unsupported | exact | unsupported | unsupported |
| `expression.duckdb.json` — DuckDB native JSON functions and operators | function-family | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `expression.duckdb.lambda` — DuckDB LIST lambdas and comprehensions | expression | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `expression.function.call` — Catalog and application function calls | function-family | conservative | conservative | conservative | conservative (from 3.39.0) | conservative |
| `expression.function.date-time` — SQLite date and time functions and modifiers | function-family | out-of-scope | out-of-scope | out-of-scope | exact (from 3.39.0) | out-of-scope |
| `expression.function.json` — SQLite JSON and JSONB scalar, aggregate, operator, and table functions | function-family | out-of-scope | out-of-scope | out-of-scope | exact (from 3.39.0) | out-of-scope |
| `expression.function.math-extensions` — SQLite compile-option math and extension functions | function-family | out-of-scope | out-of-scope | out-of-scope | exact (from 3.39.0) | out-of-scope |
| `expression.function.registry` — SQLite application-defined scalar, aggregate, and window routine registry | function-family | out-of-scope | out-of-scope | out-of-scope | exact (from 3.39.0) | out-of-scope |
| `expression.interval-literal` — PostgreSQL interval literals and field qualifiers | expression | exact | unsupported | exact | unsupported | unsupported |
| `expression.json-path` — PostgreSQL JSON-path literals, operators, and core routines | expression | unsupported | unsupported | exact | unsupported | unsupported |
| `expression.operator` — Unary and binary operators | operator | conservative | conservative | conservative | conservative (from 3.39.0) | conservative |
| `expression.quantified-comparison` — ANY, SOME, and ALL comparisons | expression | unsupported | conservative | exact | unsupported | unsupported |
| `expression.row-comparison` — Row constructor comparisons | expression | conservative | conservative | exact | conservative | unsupported |
| `expression.scalar` — Columns, stars, literals, and parameters | expression | exact | exact | exact | exact | exact |
| `expression.sql-json-aggregates` — PostgreSQL SQL/JSON object and array aggregates | expression | unsupported | unsupported | exact (from 16) | unsupported | unsupported |
| `expression.sql-json-constructors` — PostgreSQL SQL/JSON object and array constructors | expression | unsupported | unsupported | exact (from 16) | unsupported | unsupported |
| `expression.sql-json-conversion` — PostgreSQL SQL/JSON parsing, scalar conversion, and serialization | expression | unsupported | unsupported | exact (from 17) | unsupported | unsupported |
| `expression.sql-json-exists` — PostgreSQL SQL/JSON JSON_EXISTS expression | expression | unsupported | unsupported | exact (from 17) | unsupported | unsupported |
| `expression.sql-json-predicate` — PostgreSQL SQL/JSON IS JSON predicate | expression | unsupported | unsupported | exact (from 16) | unsupported | unsupported |
| `expression.sql-json-query` — PostgreSQL SQL/JSON JSON_QUERY expression | expression | unsupported | unsupported | exact (from 17) | unsupported | unsupported |
| `expression.sql-json-value` — PostgreSQL SQL/JSON JSON_VALUE expression | expression | unsupported | unsupported | exact (from 17) | unsupported | unsupported |
| `expression.sqlserver.json` — T-SQL JSON functions and OPENJSON | function-family | out-of-scope | out-of-scope | out-of-scope | out-of-scope | exact (from 14) |
| `expression.structured` — Row, CASE, predicate, and subquery expressions | expression | exact | exact | exact | exact | conservative |
| `lexical.duckdb.backtick-identifiers` — DuckDB backtick identifiers | lexical | exact (from 2.0.0) | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `lexical.structure` — Identifiers, literals, comments, parameters, tokens, and source ranges | lexical | exact | exact | exact | conservative | exact |
| `query.cte` — Ordinary common table expressions | clause | exact | exact (from 8.0.1) | exact (from 8.4) | exact (from 3.8.3) | exact |
| `query.distinct` — DISTINCT and ALL projection modifiers | clause | exact | exact | exact | exact | exact |
| `query.distinct-on` — DISTINCT ON | clause | exact | unsupported | exact | unsupported | unsupported |
| `query.duckdb.qualify` — DuckDB QUALIFY and analytical joins | clause | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `query.duckdb.unnest` — DuckDB recursive UNNEST and WITH ORDINALITY | clause | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `query.grouping` — GROUP BY, HAVING, and grammar-specific grouping forms | clause | exact | exact | exact | exact | exact |
| `query.join` — Named, cross, inner, and outer joins | clause | exact | exact | exact | exact | exact |
| `query.join.full` — FULL OUTER JOIN | clause | exact | unsupported | exact | exact (from 3.39.0) | exact |
| `query.locking.read` — Locking read clauses | clause | unsupported | exact | exact | unsupported | unsupported |
| `query.ordering-pagination` — Ordering, limiting, and offsetting rows | clause | exact | exact | exact | exact | exact |
| `query.projection` — Projection items, aliases, and output naming | clause | exact | exact | exact | exact | exact |
| `query.relation` — Named tables and derived table references | clause | exact | exact | exact | exact | exact |
| `query.relation.derived-alias-optional` — PostgreSQL unaliased derived tables | clause | conservative | unsupported | exact (from 16) | out-of-scope | unsupported |
| `query.relation.function` — Function calls as table relations | clause | exact | unsupported | exact | exact | exact |
| `query.relation.json-table` — PostgreSQL SQL/JSON JSON_TABLE row source | clause | unsupported | unsupported | exact (from 17) | unsupported | unsupported |
| `query.relation.lateral` — LATERAL derived tables | clause | conservative | exact (from 8.0.14) | exact (from 9.3) | unsupported | unsupported |
| `query.relation.rows-from` — PostgreSQL ROWS FROM and WITH ORDINALITY | clause | unsupported | unsupported | exact | unsupported | unsupported |
| `query.relation.table-sample` — PostgreSQL TABLESAMPLE and REPEATABLE | clause | unsupported | unsupported | exact | unsupported | unsupported |
| `query.set-operation` — Set operations | clause | exact | exact (from 8.0.31) | exact | exact | exact |
| `query.sqlserver.apply` — T-SQL CROSS APPLY and OUTER APPLY | clause | out-of-scope | out-of-scope | out-of-scope | out-of-scope | exact |
| `query.sqlserver.top` — T-SQL TOP, PERCENT and WITH TIES | clause | out-of-scope | out-of-scope | out-of-scope | out-of-scope | exact |
| `query.window` — Named and inline window specifications | clause | exact | exact (from 8.0) | exact (from 8.4) | exact (from 3.25.0) | exact |
| `query.with.recursive` — Recursive common table expressions | clause | exact | exact (from 8.0.1) | exact (from 8.4) | exact (from 3.8.3) | exact |
| `query.with.search-cycle` — Recursive CTE SEARCH and CYCLE clauses | clause | unsupported | unsupported | exact (from 14) | unsupported | unsupported |
| `resolver.catalog` — Catalog name, type, coercion, and nullability resolution | coercion | conservative | conservative | conservative | conservative (from 3.39.0) | conservative |
| `runtime.bulk-transfer` — Native bulk import and export capabilities | runtime | exact | exact | exact | unsupported | out-of-scope |
| `runtime.codec-policy` — Compile-time and runtime type codec policy | runtime | exact | exact | exact | exact | exact |
| `runtime.duckdb.appender` — DuckDB typed vector appender | runtime | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `runtime.execution` — Buffered, prepared, batched, and transactional execution | runtime | exact | exact | exact | exact | exact |
| `runtime.execution-control` — Cancellation signals and absolute deadlines | runtime | exact | exact | exact | unsupported | conservative |
| `runtime.extension-manifest.postgres` — Versioned PostgreSQL extension manifests | runtime | out-of-scope | unsupported | exact | unsupported | out-of-scope |
| `runtime.introspection` — Schema and server-evidence introspection | schema | exact | exact | exact | exact (from 3.39.0) | exact |
| `runtime.pipeline.postgres` — PostgreSQL protocol pipeline execution | runtime | out-of-scope | out-of-scope | exact | out-of-scope | out-of-scope |
| `runtime.streaming` — Bounded asynchronous row streaming | runtime | exact | exact | exact | exact | exact |
| `runtime.verification-and-plans` — Live metadata verification and query-plan inspection | runtime | exact | exact | exact | unsupported | exact |
| `schema.column.generated-assignment` — Generated-column insert and update restrictions | schema | conservative | conservative | conservative | exact | conservative |
| `schema.sqlite.structural-evidence` — SQLite rowid, generated, virtual, index, constraint, and attached-database evidence | schema | out-of-scope | out-of-scope | out-of-scope | exact (from 3.39.0) | out-of-scope |
| `schema.table.strict` — STRICT tables | type-family | out-of-scope | out-of-scope | out-of-scope | exact (from 3.37.0) | out-of-scope |
| `semantic.query-evidence` — Operation, dependency, cardinality, volatility, locking, and affinity evidence | semantic | conservative | conservative | conservative | conservative | conservative |
| `statement.cte.data-modifying` — Data-modifying statements in common table expressions | statement | exact (from 2.0.0) | conservative | exact | unsupported | unsupported |
| `statement.delete` — DELETE statements | statement | exact | exact | exact | exact | exact |
| `statement.dml.delete-using` — DELETE USING source relations | clause | exact | exact | exact | unsupported | unsupported |
| `statement.dml.modifiers` — DML priority, IGNORE, QUICK, partition, ordering, and limit modifiers | clause | out-of-scope | exact | out-of-scope | out-of-scope | out-of-scope |
| `statement.dml.multi-table` — MySQL multi-table UPDATE and DELETE | statement | out-of-scope | exact | out-of-scope | out-of-scope | out-of-scope |
| `statement.dml.positioned-update-delete` — PostgreSQL positioned UPDATE and DELETE | clause | unsupported | unsupported | exact | unsupported | unsupported |
| `statement.dml.returning` — DML RETURNING clause | clause | exact | unsupported | exact | exact (from 3.35.0) | unsupported |
| `statement.dml.returning-old-new` — PostgreSQL OLD and NEW RETURNING namespaces | clause | unsupported | unsupported | exact (from 18) | unsupported | unsupported |
| `statement.dml.update-from` — UPDATE FROM source relations | clause | exact | unsupported | exact | exact (from 3.33.0) | exact |
| `statement.duckdb.describe-summarize` — DuckDB DESCRIBE and SUMMARIZE | statement | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `statement.insert` — INSERT statements and multi-row VALUES sources | statement | exact | exact | exact | exact | exact |
| `statement.insert.conflict` — INSERT conflict handling and UPSERT clauses | clause | exact | unsupported | exact (from 9.5) | exact (from 3.24.0) | unsupported |
| `statement.insert.default-values` — INSERT DEFAULT VALUES | clause | exact | unsupported | exact | exact | exact |
| `statement.insert.duplicate-key` — MySQL ON DUPLICATE KEY UPDATE and inserted-row aliases | clause | out-of-scope | exact | out-of-scope | out-of-scope | out-of-scope |
| `statement.insert.identity-overriding` — INSERT identity OVERRIDING clauses | clause | unsupported | unsupported | exact | unsupported | unsupported |
| `statement.merge` — Versioned PostgreSQL MERGE statements | statement | unsupported | unsupported | exact (from 15) | unsupported | unsupported |
| `statement.out-of-scope.commands` — Administrative, replication, maintenance, and procedural commands | statement | out-of-scope | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `statement.replace` — MySQL REPLACE statements | statement | unsupported | exact | out-of-scope | out-of-scope | unsupported |
| `statement.select` — SELECT statements | statement | exact | exact | exact | exact | exact |
| `statement.sqlserver.output` — T-SQL OUTPUT and OUTPUT INTO | clause | out-of-scope | out-of-scope | out-of-scope | out-of-scope | exact |
| `statement.update` — UPDATE statements and assignments | statement | exact | exact | exact | exact | exact |
| `tooling.compiler.artifacts` — Static extraction, generated declarations, and query manifests | tooling | exact | exact | exact | exact | exact |
| `tooling.diagnostics` — Stable diagnostics, suggestions, and source spans | tooling | exact | exact | exact | exact | exact |
| `tooling.editor.integration` — TypeScript preview bridge and language-server analysis | tooling | conservative | conservative | conservative | conservative | conservative |
| `tooling.parser.resource-limits` — Bounded SQL length, token count, and parse depth | tooling | exact | exact | exact | exact | exact |
| `tooling.structural-sql` — Explicit structural SQL and parameter-safe composition | tooling | exact | exact | exact | exact | exact |
| `type.duckdb.map` — DuckDB ordered typed MAP | type-family | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `type.duckdb.struct` — DuckDB STRUCT and positional TUPLE | type-family | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `type.duckdb.timestamp-tz-nanoseconds` — DuckDB nanosecond timezone-aware temporal types | type-family | exact (from 2.0.0) | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `type.duckdb.union` — DuckDB tagged UNION | type-family | exact | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `type.duckdb.variant` — DuckDB VARIANT codec boundary | type-family | unsupported | out-of-scope | out-of-scope | out-of-scope | out-of-scope |
| `type.sqlserver.native-json` — SQL Server native JSON and RETURNING JSON | type-family | out-of-scope | out-of-scope | out-of-scope | out-of-scope | exact (from 17) |

Administrative, replication, maintenance, and procedural command languages are outside the application-query contract. They receive syntax, unsupported, or dynamic-query diagnostics when encountered through static analysis.

This page is generated from `grammar/features/ledger.json`. Update the ledger, its executable evidence, and this page together.
