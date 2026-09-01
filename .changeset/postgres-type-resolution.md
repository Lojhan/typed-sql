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

Expose optional routine argument names and default evidence through the neutral resolver bridge so
grammar packages can implement named, defaulted, and variadic call selection.
