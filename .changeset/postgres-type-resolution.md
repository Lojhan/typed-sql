---
"@typed-sql/postgres": minor
"@typed-sql/core": minor
---

Resolve PostgreSQL operators and snapshot v2 routines through a grammar-owned candidate selector
that uses canonical types, cast contexts, preferred categories, unknown-literal rules, domains,
arrays, ranges, enums, and the `anyelement` and `anycompatible` polymorphic families.
Named, defaulted, expanded-variadic, and explicit-variadic routine calls now select against snapshot
argument evidence, while known invalid explicit casts produce a stable diagnostic.
The versioned core catalog now recognizes PostgreSQL temporal, bit-string, network, geometric,
full-text, XML, range, multirange, object-identifier, and related scalar types. Unary numeric and
bitwise operators, plus binary integer and bit-string operators, now resolve through typed
candidates and reject invalid operands. Date, timestamp, time, and interval arithmetic now uses
asymmetric PostgreSQL signatures, with parameter inference deferred until candidate selection.
Built-in range/multirange containment and arithmetic, network containment and address arithmetic,
full-text search composition, JSON-path predicates and deletion, and their multi-character tokens
now use exact grammar-owned signatures.
Geometric transformation, position, intersection, distance, containment, and relationship operators
now resolve through their exact operand and result signatures, including prefix forms.
Numeric promotion, mathematical prefix, bit-string shift, binary/JSON/text concatenation, money,
`pg_lsn`, and tuple-identifier operators now use catalog-derived signatures and coercions.
Array subscripts infer nullable element types, slices preserve the array type, omitted bounds are
represented explicitly, index parameters infer `integer`, and nested array mappings retain every dimension.
`ANY`, `SOME`, and `ALL` comparisons now resolve array elements or single-column subqueries through
the operator catalog, while row comparisons validate arity and select an operator for each field pair.
Parenthesized composite field selection now uses snapshot v2 field evidence for its database type,
TypeScript type, nullability, parameter context, and unknown-field diagnostics.
`COLLATE` now preserves collatable expression types, and `AT TIME ZONE` resolves PostgreSQL's exact
timestamp, timestamp-with-time-zone, and time-with-time-zone conversions with text or interval zones.
PostgreSQL 17 and newer also resolve and version-gate the corresponding `AT LOCAL` forms.
Scalar and row-valued `IN` lists and subqueries now validate equality candidates, numeric literals,
row arity, composite field comparability, nullability, and per-position parameter contexts.
The versioned cast catalogs now include every direct `pg_cast` conversion among shipped core types
for PostgreSQL 14 through 18, including the PostgreSQL 15 geometric removal and PostgreSQL 18
integer/bytea additions. Automatic assignment-to-string and explicit string I/O casts follow the
server's fallback conversion rules.
PostgreSQL interval literals now parse prefix precision, every valid field and field-range qualifier,
suffix second precision, and qualified interval cast types while retaining typed-literal source spans.
All forms resolve through the canonical `interval` type, and invalid field ranges fail during parsing.

Expose optional routine argument names and default evidence through the neutral resolver bridge so
grammar packages can implement named, defaulted, and variadic call selection.
