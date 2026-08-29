---
title: Inference and safety
description: Learn when typed-sql returns exact types, conservative unknowns, or diagnostics and where runtime validation still belongs.
---

# Inference and safety

typed-sql fails closed. A query receives an exact type, a conservative `unknown`, or a diagnostic. It never receives a plausible but unproven row or parameter type.

## Inference outcomes

### Exact

The complete row, ordered parameter tuple, result kind, and relevant nullability are proven from the SQL grammar and generated schema.

```ts
Query<
  { id: bigint; email: string; budget: string | null },
  readonly [bigint]
>
```

### Unknown

Analysis has insufficient evidence for a row property or parameter position. That position becomes `unknown`. This preserves safety while allowing valid SQL outside the current inference surface.

### Diagnostic

Invalid, ambiguous, conflicting, stale, malformed, or deliberately unsupported SQL produces a stable diagnostic code and source range. The compiler does not emit a confident query overlay for that statement.

## Nullability

Nullability follows both catalog metadata and SQL structure. A nullable column and a column from the nullable side of an outer join become `T | null`. Aggregate and function nullability belong to the selected grammar.

## Parameters

Each interpolation is resolved from its SQL context and stored in placeholder order. Positions without enough evidence remain `unknown`. Query values are always rendered as driver parameters unless the developer selects an explicit structural API.

## Trusted structure

`sql.fragment`, `sql.ident()`, and `sql.raw()` are distinct trust boundaries:

- `sql.fragment` marks static template structure while preserving nested values as parameters.
- `sql.ident()` delegates safe identifier quoting to the grammar.
- `sql.raw()` inserts trusted SQL unchanged and is not an escaping API.

A nested JavaScript template is not trusted SQL by itself. When used as a structural branch, it produces `TSQ004` and can be changed to `sql.fragment` explicitly.

## Dynamic SQL

Use `sql.dynamic()` for SQL whose structure cannot be represented statically. Its row type is deliberately `unknown`. Arbitrary strings are never promoted to statically trusted structure.

## Runtime trust boundaries

Static types describe the configured schema and adapter policy. They do not validate untrusted request payloads, data written outside database constraints, or serialized responses. At a database result boundary, `sql.validateResult(query, schema)` can attach an application-owned Standard Schema validator whose output agrees with the inferred row. See [Validate query results](../guides/result-validation.md) for the decoding order, execution behavior, and redaction policy.

## Resource limits

The tokenizer, parser, structural expansion, workspace scan, and editor caches are bounded. Limit violations produce diagnostics rather than unbounded CPU or memory use. See [Diagnostics](../reference/diagnostics.md) and [Performance](./performance.md).
