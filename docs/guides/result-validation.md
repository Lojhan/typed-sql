---
title: Validate query results
pageType: how-to
description: Add opt-in Standard Schema validation to inferred query results without coupling typed-sql to a validator library.
---

# Validate query results

Compile-time inference proves the contract described by the configured database snapshot and codec policy. At an application trust boundary, you can additionally validate the decoded rows returned by the database.

typed-sql accepts [Standard Schema V1](https://standardschema.dev/schema). The interface is implemented by Zod, Valibot, ArkType, Yup, Joi, and other validators, so neither `@typed-sql/core` nor a grammar package depends on a validator library.

## Attach a validator

Create an ordinary inferred query, then use `sql.validateResult(query, schema)`:

```ts
import { sql } from "@typed-sql/postgres";
import { z } from "zod";

const accountSchema = z.object({
  id: z.bigint(),
  email: z.string().email(),
  status: z.enum(["active", "suspended"]),
});

const accountQuery = sql`
  SELECT account.id, account.email, account.status
  FROM accounts AS account
  WHERE account.id = ${accountId}
`;

const validatedAccountQuery = sql.validateResult(accountQuery, accountSchema);
const account = await database.maybeOne(validatedAccountQuery);
```

The returned query keeps the original ordered parameter tuple and uses the validator output as its row type. TypeScript rejects a schema whose output is not assignable to the compiler-inferred row. A schema with `any` output is also rejected because it cannot establish a sound boundary.

The operation is immutable: attaching validation creates a new query value. Executing `accountQuery` remains unvalidated; executing `validatedAccountQuery` validates.

Valibot uses the same API without an adapter:

```ts
import * as v from "valibot";

const accountSchema = v.object({
  id: v.bigint(),
  email: v.pipe(v.string(), v.email()),
  status: v.picklist(["active", "suspended"]),
});

const validatedAccountQuery = sql.validateResult(accountQuery, accountSchema);
```

## Understand the boundary

The row passes through three separate layers:

1. The compiler infers a static `Query<Row, Parameters>` from SQL, schema metadata, and the selected type policy.
2. The runtime adapter decodes native driver values according to that type policy.
3. The attached Standard Schema validates or transforms each decoded row before it reaches application code.

PostgreSQL and MySQL therefore present the same decoded values to a validator that their unvalidated execution APIs would return. Validation does not inspect raw protocol values and does not replace snapshot generation, live verification, or database constraints.

Standard Schema permits synchronous and asynchronous validators. Both are accepted. Rows are validated in result order, which keeps row indexes deterministic and prevents unbounded concurrent validator work.

## Execution behavior

Validation applies consistently to every official adapter:

- `execute()` and `all()` validate every decoded row.
- `one()` and `maybeOne()` validate rows before checking cardinality.
- `batch()` and PostgreSQL `pipeline()` validate each result against its own attached schema.
- `stream()` validates lazily immediately before yielding each row.
- transaction-scoped operations use the same rules; an uncaught validation failure rejects the callback and rolls back the transaction.

On a stream failure, typed-sql closes the native stream and releases or retires its connection through the adapter's normal cleanup path. Rows yielded before the invalid row remain consumed; validation cannot undo application work already performed for them.

## Handle failures safely

`QueryResultValidationError` has code `TSQL_RESULT_VALIDATION` and exposes:

- `fingerprint`: the dialect- and grammar-version-scoped query identity;
- `rowIndex`: the zero-based position in the individual result;
- `vendor`: the validator's Standard Schema vendor name;
- `failure`: `issues`, `validator-exception`, or `invalid-result`;
- `issues`: normalized property paths.

Actual rows and parameter values are never attached to the error. Vendor issue messages may contain values, so they are redacted by default. Enable them only for a controlled diagnostic boundary:

```ts
const query = sql.validateResult(accountQuery, accountSchema, {
  includeIssueMessages: true,
  libraryOptions: { locale: "en" },
});
```

`libraryOptions` is passed through the Standard Schema options object. Its meaning belongs to the selected validator.

## Performance policy

Validation is opt-in per query. An unvalidated query performs one constant-time attachment lookup at the adapter boundary; it does not hash a fingerprint, allocate validation state, or call validator code. Enabled cost is proportional to the returned rows and the validator selected by the application.

Use runtime validation where the additional runtime proof is worth that cost—for example, external databases, tenant-controlled schemas, custom codecs, or security-sensitive response boundaries. Ordinary internal queries can retain the raw-driver-oriented unvalidated path.
