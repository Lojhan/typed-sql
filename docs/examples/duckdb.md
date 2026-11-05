---
title: DuckDB nested and analytical queries
pageType: tutorial
description: Preserve STRUCT, LIST, MAP and tagged UNION values while using DuckDB analytical joins, lambdas, QUALIFY and scoped execution.
---

# DuckDB nested and analytical queries

Configure the [DuckDB quickstart](../getting-started/duckdb.md) before using these examples. SQL files
compile through the stable [build integrations](../integrations/index.md); inline application queries
import `sql` from `@typed-sql/duckdb` and use an integration that compiles inline templates.

## Build a nested result

Against the quickstart's `users` table:

```ts
import { sql } from "@typed-sql/duckdb";

export const userDocument = (id: bigint) => sql`
  SELECT u.id, {
    'email': u.email,
    'profile': u.profile,
    'labels': list_transform(u.profile.tags, lambda label: upper(label))
  } AS document
  FROM users AS u
  WHERE u.id = ${id}
`;
```

`document` is a structured object. Its nested LIST keeps nullable elements, while the `id` input
remains a `bigint` parameter. Native structures retain bigint, decimal, byte and union distinctions;
they are not serialized through JSON to obtain an object shape.

## Use maps and tagged unions

```sql
SELECT
  MAP {'primary': 1::BIGINT, 'secondary': 2::BIGINT} AS counters,
  CAST(union_value(number := NULL::BIGINT)
       AS UNION(number BIGINT, text VARCHAR)) AS choice
```

The map is an ordered readonly sequence of entries, with string keys and nullable bigint values.
The union is discriminated by `tag`; this row's `choice` has the active `number` tag and a NULL
payload. It differs from `NULL::UNION(number BIGINT, text VARCHAR)`.

Applications can bind nested values using an explicit target cast:

```ts
export const echoChoice = (
  choice: { readonly tag: "number"; readonly value: bigint | null }
    | { readonly tag: "text"; readonly value: string | null }
    | null,
) => sql`
  SELECT ${choice}::UNION(number BIGINT, text VARCHAR) AS choice
`;
```

The adapter validates the shape, tag and payload before native binding. Fixed ARRAY targets also
validate their exact length. See the [native value table](../dialects/duckdb.md#native-values).

## Rank rows with QUALIFY

```sql
SELECT
  id,
  email,
  row_number() OVER (ORDER BY id) AS position
FROM users
QUALIFY position <= :maximum
```

A named SQL factory accepts an object such as `{ maximum: 10n }` when its comparison supplies the
BIGINT context. Named and positional input contracts are checked against the resolved expression.

## Flatten deterministic structures

```sql
SELECT unnest(
  [{'id':1::BIGINT, 'profile':{'label':'first'}},
   {'id':2::BIGINT, 'profile':{'label':'second'}}],
  recursive := true
)
```

The output columns are `id` and `label`. `max_depth := 1` preserves the STRUCT element instead of
recursively expanding it. Recursive UNNEST preserves lists contained inside struct fields.
Dynamic depth or schema arguments receive diagnostics when the output shape cannot be proven.

For a table function with row positions:

```sql
SELECT value, position
FROM unnest([10,20,30]) WITH ORDINALITY AS entries(value, position)
```

## Reuse, batch and stream compiled queries

SQL-file factories are accepted directly by the native execution adapter:

```ts
const byId = database.prepare("find-user", findUser);
const user = await database.maybeOne(byId({ id: 1n }));
await database.unprepare("find-user");

const rows = await database.batch([
  findUser({ id: 1n }),
  findUser({ id: 2n }),
]);

for await (const row of database.stream(findUser({ id: 1n }))) {
  console.log(row.email);
}
```

`unprepare` releases native variants and retires that factory. Root batches run atomically; batches
inside a transaction reuse its ownership. Close or consume a started stream before its transaction
callback returns. Cancellation, deadlines and lazy Standard Schema validation follow the shared
[execution contract](../guides/execution.md) and
[result-validation contract](../guides/result-validation.md).
