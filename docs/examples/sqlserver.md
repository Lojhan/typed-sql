---
title: SQL Server examples
pageType: tutorial
description: Compose SQL Server parameters, APPLY, mapped INSERT OUTPUT, exact values, prepared factories, transactions and streams.
---

# SQL Server examples

Use the [quickstart](../getting-started/sqlserver.md) schema and configuration. Compile examples with the quickstart’s esbuild integration so the stable compiler supplies checked
native value plans for inline templates and SQL file imports.

## Named and positional SQL files

A named SQL file accepts one object:

```sql
-- src/order-by-id.sql
SELECT id, status, amount, placed_at
FROM dbo.orders
WHERE id = :orderId
```

```ts
import orderById from "./order-by-id.sql";

const order = await database.one(orderById({ orderId: 9001n }));
// amount is exact decimal text; placed_at retains seven fractional digits.
```

Native `@name` markers are also supported by the SQL-file frontend. For positional arguments,
use `?` markers; each physical occurrence has an ordered tuple slot. Generate SQL-file
declarations with `typed-sql-build types --include 'src/**/*.sql'` and enable
`allowArbitraryExtensions` in your TypeScript configuration. Scoping discovery to `src` keeps
the quickstart's setup-only `schema.sql` out of query compilation. See [SQL files](../guides/sql-files.md).

## Correlated APPLY and pagination

```ts
import { sql } from "@typed-sql/sqlserver";

export const customerOrders = (userId: bigint, skip: bigint, take: bigint) => sql`
  SELECT o.id, o.status, totals.item_count
  FROM dbo.orders AS o
  OUTER APPLY (
    SELECT COUNT_BIG(*) AS item_count
    FROM dbo.order_items AS i
    WHERE i.order_id = o.id
  ) AS totals
  WHERE o.user_id = ${userId}
  ORDER BY o.placed_at DESC, o.id
  OFFSET ${skip} ROWS FETCH NEXT ${take} ROWS ONLY
`;
```

SQL Server requires an order for pagination. `TOP` expressions use parentheses:

```ts
export const recentOrders = (take: bigint) => sql`
  SELECT TOP (${take}) id, status FROM dbo.orders ORDER BY placed_at DESC, id
`;
```

## Mapped values and OUTPUT

```ts
export const addProducts = (
  products: readonly { id: bigint; sku: string; name: string; priceCents: number }[],
) => sql`
  INSERT INTO dbo.products(id, sku, name, price_cents)
  OUTPUT inserted.id, inserted.sku
  VALUES ${products.map((product) => sql.fragment`
    (${product.id}, ${product.sku}, ${product.name}, ${product.priceCents})
  `)}
`;
```

Each map element remains a separate fragment with ordered parameters. The row count changes the
number of bindings, while `OUTPUT` retains its named result shape. Supply at least one row and
stay within SQL Server's 2,100 parameter limit. The native `VALUES` table constructor also limits
one `INSERT ... VALUES` statement to 1,000 rows.

Targets with enabled triggers require a compatible `OUTPUT INTO` destination. The catalog records
trigger restrictions and the analyzer rejects an unsupported direct result form.

## Exact values and nullable inputs

```ts
export const updateAmount = (orderId: bigint, amount: string) => sql`
  UPDATE dbo.orders
  SET amount = ${amount}
  OUTPUT inserted.id, inserted.amount, inserted.placed_at
  WHERE id = ${orderId}
`;

await database.one(updateAmount(9001n, "1234567890123456789012345678.1234567890"));
```

The decimal codec rejects a value that needs rounding or exceeds the target precision. Binary
inputs use typed hexadecimal conversion, so empty bytes differ from SQL `NULL`. The selected
policy controls both inference and decoding; see [native value policies](../dialects/sqlserver.md#exact-values).

## Prepared factories and transactions

```ts
const findOrder = database.prepare("order-by-id", orderById);

await database.transaction(async (transaction) => {
  const order = await transaction.one(findOrder({ orderId: 9001n }));
  await transaction.batch([
    updateAmount(order.id, "32.9800000000"),
    updateAmount(9002n, "25.9800000000"),
  ]);
});
```

Scope batches use the current transaction. Root batches are atomic. Await every operation and
close active streams before returning. Nested transactions are explicitly unsupported.
Logical prepared factories reuse native handles with fixed MAX bindings for short, long, empty
and nullable values; [physical preparation](../dialects/sqlserver.md#execution-and-physical-preparation)
explains the driver boundary.

## Stream with explicit cleanup

```ts
const stream = database.stream(customerOrders(1n, 0n, 100n), { batchSize: 32 });
try {
  for await (const row of stream) console.log(row.id, row.item_count);
} finally {
  await stream.close();
}
```

The stream leases its connection until exhaustion or cleanup. The batch size bounds preferred
row buffering, rather than declaring server cursor pagination. Standard Schema result validators
run after decoding and immediately before each row is yielded.
