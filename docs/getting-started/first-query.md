---
title: Your first query
description: Write a static SQL template and use its inferred row and ordered parameter types.
pageType: tutorial
---

# Your first query

Import `sql` from the selected dialect root. This import tells typed-sql which grammar should analyze the template.

```ts
import { sql } from "@typed-sql/postgres";

const accountId = 42n;

export const accountQuery = sql`
  SELECT account.id, account.email, account.status
  FROM accounts AS account
  WHERE account.id = ${accountId}
`;
```

For a schema where `accounts.id` is `bigint`, `email` is text, and `status` is a database enum, the query type is equivalent to:

```ts
Query<
  {
    id: bigint;
    email: string;
    status: "active" | "suspended";
  },
  readonly [bigint]
>
```

The parameter type comes from its SQL position. Passing a string is a normal TypeScript error:

```ts
const wrongId = "42";

sql`
  SELECT account.id
  FROM accounts AS account
  WHERE account.id = ${wrongId}
`;
```

Use `QueryRow` and `QueryParameters` when another type should follow a query:

```ts
import type { QueryParameters, QueryRow } from "@typed-sql/core";

type Account = QueryRow<typeof accountQuery>;
type AccountQueryParameters = QueryParameters<typeof accountQuery>;
```

Unsupported, ambiguous, or insufficiently proven SQL produces a diagnostic or a conservative `unknown`. typed-sql does not replace uncertain evidence with `any`.

Next, learn how to [execute the query](../guides/execution.md) or [compose conditional SQL](../guides/composition.md).
