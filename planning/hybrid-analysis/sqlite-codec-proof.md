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

## Live fingerprint review

Fresh local native inventory and matrix captures changed only the ABS/SUM runtime descriptors
in two observations per context. Comparing complete observations with the preceding reviewed
captures, after removing those descriptor fields, preserves native outcomes, native metadata,
diagnostics, static types, source spans and counts exactly. The initial review covers two Darwin
arm64 / SQLite 3.53.4 contexts.

[CI run 42541005388](https://github.com/Lojhan/typed-sql/actions/runs/42541005388) then supplies
fresh Linux evidence for all seven SQLite matrix targets and the standalone Node 24.22.2 capture.
The seven matrix captures pass every behavioral probe and stop only at the expected fingerprint
review. Removing the new ABS/SUM descriptor fields reproduces each preceding complete fingerprint
exactly, including the standalone Linux capture. All ten observed contexts retain their previous
recognition counts and reviewed native inventories. No unobserved context is added. A fresh CI
run must consume these reviewed updates before the remote matrix can be considered green.

The broader repository suite also exposed stale CI wiring: the main workflow called a workflow
without `workflow_call` and retained four invocations of a removed catalog-generation command.
The audit workflow is now callable, its direct/reused concurrency groups are separate, and the
obsolete steps are removed. Native matrix probes continue to enforce reviewed language captures.
Repository contracts check that local reusable workflows are callable, root CI script names exist
and DuckDB qualification derives SDK targets from its support policy.

The now-running CI also exposes a DuckDB packed-host launcher that imported TypeScript-backed
fixtures through plain Node without their loader. The build-host wrapper now uses the same tsx
module-import mechanism as the native audit tooling. SDK targets still come from grammar policy;
the packed application itself continues to use published package entrypoints.
The exact plain-Node/Poku build-host entrypoint passes locally on both qualified SDKs, including
native contracts, editor refresh, offline/no-SDK builds and bundled execution (135 seconds).
The reviewed-capture/conformance tests, workspace types and quality check pass afterward.
