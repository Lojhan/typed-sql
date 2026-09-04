---
title: SQL dialects
description: Choose a stable typed-sql grammar and understand the difference between supported ranges and exact verification targets.
pageType: landing
---

# SQL dialects

Application code imports `sql` from one selected grammar package. That package—not the neutral AST or
compiler—owns SQL syntax, built-ins, coercions, nullability, version gates, and diagnostics.

| Grammar | Stable language range | Driver boundary |
| --- | --- | --- |
| [PostgreSQL](./postgresql.md) | Majors 14–18 | Application-owned `pg`; optional adapter at `@typed-sql/postgres/pg` |
| [MySQL](./mysql.md) | 8.4 and 9.7 LTS series | Application-owned `mysql2`; optional adapter at `@typed-sql/mysql/mysql2` |
| [SQLite](./sqlite.md) | 3.39.0–3.53.4 complete baseline | Injected connection or optional built-in `node:sqlite` adapter |

These three grammar packages are on the stable package track. A stable range is not the same thing as
the exact versions exercised by the repository. Each dialect page lists both, including non-blocking
future-version canaries.

## How support is classified

- **Exact** means executable evidence proves row types, ordered parameters, diagnostics, and relevant
  semantics for that feature.
- **Conservative** means missing or ambiguous evidence preserves `unknown`.
- **Unsupported** means the grammar recognizes that the feature is unavailable and fails closed.
- **Out of scope** means the feature belongs to another grammar or is deliberately not modeled.

Review the generated [grammar support matrix](../reference/grammar-support.md) for individual features.

## Driver independence

Installing a grammar does not install a database driver. Driver-specific imports are separate public
entrypoints and are loaded only when selected. You may keep direct driver execution, create a typed-sql
adapter, or [adapt an existing pool](../guides/existing-pools.md).

Runtime decoding and compile-time inference use the same type policy. If the application changes its
driver parsers or codecs, configure a matching policy rather than asserting a narrower result type.

## Unknown versions and capabilities

An unrecognized future server or SQLite library is not assumed compatible. Missing version, mode,
compile-option, extension, or catalog evidence produces a diagnostic or conservative result. Consult
[Compatibility](../reference/compatibility.md) for the tested Node, TypeScript, driver, and database
matrix.
