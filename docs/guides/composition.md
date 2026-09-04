---
title: Compose conditional SQL
pageType: how-to
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

## Repeat homogeneous fragments

Interpolate a non-empty array of typed fragments directly when one statement needs a repeated,
comma-separated structure. A multi-row insert is the common case:

```ts
interface UserInput {
  readonly id: bigint;
  readonly email: string;
  readonly status: "active" | "suspended";
}

function insertUsers(items: readonly UserInput[]) {
  if (items.length === 0) throw new RangeError("insertUsers requires at least one item");

  return sql`
    INSERT INTO users (id, email, status)
    VALUES ${items.map((item) => sql.fragment`
      (${item.id}, ${item.email}, ${item.status})
    `)}
    RETURNING id, email, status
  `;
}
```

Every mapped element is explicit structure because it is created with the selected grammar's
`sql.fragment` tag. typed-sql inserts `, ` between elements and flattens their parameters in
row-major order. The grammar analyzes a representative non-empty statement and still owns target
column coercion, nullability, result rows, and diagnostics. Runtime cardinality is not encoded as a
fixed parameter tuple: a mapped array reports an honest readonly parameter array, while a literal
tuple of fragments can retain its exact concatenated tuple.

The compiler recognizes direct synchronous `.map()` callbacks with one stable fragment skeleton,
plus direct fragment array literals. A helper call, `flatMap`, async callback, mixed return, nested
list, or callback whose SQL text changes by branch fails closed. This is bounded structural
analysis, not unrestricted execution of JavaScript by the compiler.

Ordinary arrays remain one parameter:

```ts
const ids = [1n, 2n, 3n] as const;
const query = sql`SELECT id FROM users WHERE id = ANY(${ids})`;
```

Use `sql.join()` when the separator or empty behavior must be explicit, or when the collection is
not a directly analyzable map or literal. Existing `sql.join()` calls remain valid.

### Handle empty input before building SQL

An empty implicit fragment list has no element that proves whether the array is structural or a
bound value, and `VALUES` with no rows is not portable SQL. Branch before constructing the query:

```ts
async function createUsers(items: readonly UserInput[]) {
  if (items.length === 0) return [];
  return database.execute(insertUsers(items));
}
```

Choose the explicit alternative that matches the intent: `sql.join([])` or `sql.empty` for
deliberately absent structure, and `sql.value([])` for one bound database-array value. SQLite and
MySQL do not gain a database array type from `sql.value()`; their grammar and driver rules still
apply.

Fragment lists are limited to 10,000 elements, 65,535 rendered parameters, and 4 MiB of rendered
SQL. A database can impose a lower statement or parameter limit. Split bounded work or use a native
bulk capability when an input approaches those limits.

### Array migration behavior

Arrays containing only ordinary values continue to bind as one parameter. An array that mixes a
branded fragment with an ordinary value now fails as a mixed fragment list instead of reaching a
driver with ambiguous input. Make the whole collection structural with fragments, or make the
whole value explicit with `sql.value(values)`. Nested arrays likewise require `sql.value()` when
they represent one database value. Sparse arrays and arrays mutated after query construction cannot
silently change the captured statement structure.

## Structural limits

Independent booleans can produce `2ⁿ` complete statements. typed-sql bounds expansion before invoking a grammar. The default maximum is 64 variants and can be changed through `compiler.maxStructuralVariants`. Exceeding the limit produces `TSQ003`.

Use `sql.dynamic()` when the structure cannot be statically bounded. It deliberately returns `Query<unknown>`.
