# SQLite numeric execution codecs

The analyzer's numeric family already permits the selected integer representation and REAL
values. Its runtime descriptor now carries that same union through numeric operations, SUM,
ABS, casts, derived projections and compounds. Parameter contexts retain the descriptor too.
This derives from grammar-owned numeric rules; arbitrary SQLite type affinities on stored
columns do not establish a numeric-only storage domain.

The regression in `packages/sqlite/test/value-plan.test.ts` fails before numeric descriptor
propagation. With the correction it builds actual value plans and executes them through the
Node adapter on SQLite 3.53.4 / Node 24.22.2:

- Both bigint and number integer policies preserve integer sums and fractional REAL sums.
- An empty SUM remains nullable and decodes SQL NULL.
- A CTE retains its numeric output family and ordered threshold parameter codec/source span.
- A compound retains a flat numeric codec union instead of losing its runtime representation.
- NUMERIC casts preserve fractional values, and nonnumeric predicate inputs fail validation.

The package tests retain the conservative flexible storage model for ordinary columns. No
native acquisition admission rule, nullability guarantee or unknown-function fallback changes.
This closes the measured commerce workload's numeric codec gap; it does not establish complete
SQLite semantics or native statement qualification.

Validation passes all 17 SQLite files and their existing coverage gate (93.93% statements,
87.19% branches, 98.54% functions), clean build/types, nine soundness files, three
packed-consumer/editor suites, documentation, quality and the isolated performance gate.
