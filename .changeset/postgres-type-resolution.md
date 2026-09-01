---
"@typed-sql/postgres": minor
"@typed-sql/core": minor
---

Resolve PostgreSQL operators and snapshot v2 routines through a grammar-owned candidate selector
that uses canonical types, cast contexts, preferred categories, unknown-literal rules, domains,
arrays, ranges, enums, and the `anyelement` and `anycompatible` polymorphic families.
Named, defaulted, expanded-variadic, and explicit-variadic routine calls now select against snapshot
argument evidence, while known invalid explicit casts produce a stable diagnostic.

Expose optional routine argument names and default evidence through the neutral resolver bridge so
grammar packages can implement named, defaulted, and variadic call selection.
