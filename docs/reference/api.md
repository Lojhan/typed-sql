---
title: Query API
description: Reference the public query, fragment, database, compiler, schema, and grammar contracts.
---

# Query API

This page describes supported package entrypoints and type relationships. Internal source modules and generated folders are not public entrypoints.

## Query types

`Query<Row, Parameters>` represents one complete statement:

- `Row` is the analyzed result row.
- `Parameters` is an ordered readonly tuple matching flattened interpolation order.
- `QueryRow<QueryValue>` extracts the row.
- `QueryParameters<QueryValue>` extracts the parameter tuple.
- `Database.execute(query)` returns `Promise<readonly Row[]>`.

`Query` is invariant in both generic positions, so it cannot be silently widened to a different row or parameter contract.

`SqlFragment<Parameters>` represents trusted static structure with its own ordered parameter tuple. `OptionalSqlFragment` also accepts `undefined`, `null`, and `false` as absent values during composition.

## The `sql` tag

Applications import `sql` from their selected dialect root.

| Member | Result | Purpose |
| --- | --- | --- |
| ``sql`...` `` | `Query<Row, Parameters>` | Define a complete static query. |
| ``sql.fragment`...` `` | `SqlFragment<Parameters>` | Mark static SQL structure while preserving nested values as parameters. |
| `sql.empty` | `SqlFragment<readonly []>` | Represent no structural content. |
| `sql.ident(name)` | `SqlFragment<readonly []>` | Quote an identifier through the selected grammar. |
| `sql.value(value)` | `SqlFragment<readonly [Value]>` | Create an explicit value fragment. |
| `sql.join(parts, separator?)` | `SqlFragment` | Join trusted fragments, using a comma separator by default. |
| `sql.and(parts)` | `SqlFragment` | Join present predicates with parenthesized `AND`. |
| `sql.or(parts)` | `SqlFragment` | Join present predicates with parenthesized `OR`. |
| `sql.where(query, predicate)` | `Query` | Preserve the base row and append predicate parameters. |
| `sql.append(query, ...parts)` | `Query` | Append present fragments while preserving ordered parameters. |
| `sql.raw(text)` | `SqlFragment<readonly []>` | Insert trusted static SQL unchanged. |
| `sql.dynamic(text)` | `Query<unknown>` | Opt out of static row inference for dynamic SQL. |

`sql.raw()` is not an escaping function. Do not pass untrusted values to it.

The declarations contain an internal `sql.__typed` member used by compiler overlays. Application code must use the ordinary `sql` tag.

## Rendering and database adapters

- `renderQuery(query, renderer)` produces SQL text and values.
- `SqlRenderer` supplies grammar-specific placeholders and identifier quoting.
- `createDatabase(executor, renderer, transactionRunner)` connects the neutral query contract to a runtime adapter.
- `Database.execute()` preserves the query row type.
- `Database.transaction()` scopes execution through the adapter's transaction runner.

Most applications use `createPgDatabase` or `createMySql2Database` rather than constructing a neutral adapter directly.

## Configuration and schema contracts

`defineConfig()` accepts a `DialectPlugin`, schema file and provider, output directory, TypeScript projects, type policy, and compiler options.

Public schema types include `SchemaSnapshot`, `GeneratedSchemaSnapshot`, table, column, domain, and function metadata, `SchemaProvider`, and source-mapped diagnostics.

## Compiler entrypoints

`@typed-sql/compiler` exposes a small package-root integration surface:

- `checkFile` and its option and result types;
- `compileSource` and its query or fragment results;
- `extractStaticQueries`, `mapSqlRange`, `ExtractedQuery`, and `ExtractedInterpolation`.

Scanner control flow, append extraction, structural parsing, branch expansion, and conditional row rendering remain internal.

## Grammar entrypoints

`@typed-sql/core` exports `DialectPlugin`, `DialectCapabilities`, `SchemaProvider`, resolution and snapshot types, `DIALECT_CONTRACT_VERSION`, `assertDialectPlugin`, and grammar-neutral resolver helpers.

See [Authoring a custom grammar](../extending/custom-grammars.md).

## Compatibility policy

Removing or incompatibly changing a documented entrypoint, runtime export, type relationship, grammar contract, or diagnostic meaning requires a major version. Additive public exports may ship in a minor version. Experimental packages may change while marked experimental but must remain compatible with the matching core and compiler train.
