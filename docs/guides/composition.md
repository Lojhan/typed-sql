---
title: Compose conditional SQL
description: Build optional predicates and projections with typed SQL fragments instead of concatenating strings.
---

# Compose conditional SQL

typed-sql composes immutable SQL fragments while preserving row types and ordered parameter tuples. Structural SQL remains explicit, and interpolated values remain driver parameters.

## Optional predicates

Start from a static query and derive filter types from its inferred row:

```ts
import { sql } from "@typed-sql/postgres";
import type { QueryRow } from "@typed-sql/core";

const accountsBase = sql`
  SELECT account.id, account.email, account.status
  FROM accounts AS account
`;

type Account = QueryRow<typeof accountsBase>;
type AccountFilters = {
  readonly status?: Account["status"] | null;
  readonly minimumId?: Account["id"] | null;
};

function accounts(filters: AccountFilters, mode: "all" | "any") {
  const predicates = [
    filters.status == null
      ? undefined
      : sql.fragment`account.status = ${filters.status}`,
    filters.minimumId == null
      ? undefined
      : sql.fragment`account.id >= ${filters.minimumId}`,
  ] as const;

  return sql.where(
    accountsBase,
    mode === "all" ? sql.and(predicates) : sql.or(predicates),
  );
}
```

`sql.and()` and `sql.or()` omit `undefined`, `null`, and `false`, parenthesize present predicates, and preserve source-order parameters. An empty predicate list becomes `TRUE`. `sql.where()` keeps the base row and appends the predicate parameter tuple.

## Append clauses directly

Use `sql.append()` when an imperative `WHERE 1 = 1` shape reads more clearly:

```ts
function accounts(filters: AccountFilters) {
  const query = sql`
    SELECT account.id, account.email, account.status
    FROM accounts AS account
  `;

  return sql.append(
    query,
    sql.fragment` WHERE 1 = 1`,
    filters.status == null
      ? undefined
      : sql.fragment` AND account.status = ${filters.status}`,
    filters.minimumId == null
      ? undefined
      : sql.fragment` AND account.id >= ${filters.minimumId}`,
  );
}
```

Direct variadic fragments are analyzed cumulatively with the static base. Later fragments can use aliases and clauses introduced earlier. Variadic arguments retain exact parameter order; spreading a mutable fragment array preserves its allowed parameter union but cannot promise a fixed-length tuple.

JavaScript `query += fragment` is not type-safe. The operator converts both operands to primitives and discards the fragment's parameter metadata.

## Conditional projections

Keep conditional structure inside ordinary SQL templates:

```ts
interface AccountSelect {
  readonly status: boolean;
  readonly budget: boolean;
}

function accounts<const Select extends AccountSelect>(select: Select) {
  return sql`
    SELECT
      account.id,
      account.email
      ${select.status ? sql.fragment`, account.status` : sql.empty}
      ${select.budget ? sql.fragment`, account.budget` : sql.empty}
    FROM accounts AS account
  `;
}
```

A literal `true` or `false` produces the corresponding exact row. A runtime boolean produces a union of the possible rows. Repeated conditions are correlated so the compiler analyzes only reachable statement variants.

`sql.fragment` is the trust marker for SQL structure. A nested untagged template remains an ordinary JavaScript string and is treated as a parameter value:

```ts
sql`
  SELECT account.id
    ${select.status ? `, account.status` : sql.empty}
  FROM accounts AS account
`;
```

This produces `TSQ004`. Editor tooling can add the missing `sql.fragment` tag without changing the template contents. Values nested inside a trusted fragment remain parameters.

## Structural limits

Independent booleans can produce `2ⁿ` complete statements. typed-sql bounds expansion before invoking a grammar. The default maximum is 64 variants and can be changed through `compiler.maxStructuralVariants`. Exceeding the limit produces `TSQ003`.

Use `sql.dynamic()` when the structure cannot be statically bounded. It deliberately returns `Query<unknown>`.
