# SQL Server native acquisition evidence

[Qualification run 42532051883](https://github.com/Lojhan/typed-sql/actions/runs/42532051883)
passes all four Linux x64 jobs at `a30e4d95c1d54c1a07e1c43f1aaccfa12e4fa329`.
The matrix uses the repository's pinned engine images, Node 24.22.2 and Microsoft ODBC 18.7.1.1.

| Engine build | Compatibility levels | Reconciled contracts | Unsafe-relation rejections |
| --- | --- | --- | --- |
| 14.0.3560.2 | 140 | 7 | 4 |
| 15.0.4500.2 | 140, 150 | 14 | 8 |
| 16.0.4305.5 | 140, 150, 160 | 21 | 12 |
| 17.0.5035.5 | 140, 150, 160, 170 | 28 | 16 |

Each target describes a canonical bigint parameter, IIF, decimal(38,10), CONCAT, a table-inferred
bigint parameter, a left join with decimal metadata, and a table star. Native acquisition is
independently reconciled with offline analysis under native-required runtime-type qualification.
Actual view, computed-column, alias-type and security-predicate fixtures are rejected.

The downloaded native-contract JSON artifacts contain 110 passing cases across all ten unique
engine/compatibility targets: 70 reconciled contracts and 40 unsafe-object rejections. Inspection
confirms bigint parameter inference, ordered star columns (bigint/int/decimal), decimal(12,2)
identity and nullable join output. Contracts retain conservative nullable parameters. This is
fixture coverage, not a percentage of SQL Server syntax or functions.

Every engine also passes the installed-tarball CLI/build/editor fixture using a joined table
query and a builtin absent from the offline catalog. It exercises generation, bigint parameter
execution/decoding, SQL declarations, frozen bundling and execution, unsaved SQL/TypeScript
editor updates, routine and table DDL observation, and cache-only offline restart. Final frozen
checking/building succeeds after deleting the owned database and development cache, with
analyzer/native factories guarded against initialization.

The same run passes native transport, public adapter/introspection, catalog/permission/temporal
and public conformance checks. Local clean build/type checks, 24 SQL Server test files and their
coverage gate, quality, docs, public API/package graph, three packed-consumer/editor suites and
isolated performance checks pass.

See [the v2 table scope and consistency limits](./sqlserver-table-proof.md). This proves the
qualified guarded SELECT profile, not general SQL Server statement or custom-type support.

Native artifact SHA-256 digests (run artifacts remain outside the repository):

| Artifact | SHA-256 |
| --- | --- |
| native-contracts-14.json | 0ea47b423b4c095de2201a136521fadede41c788c3db7ecfbf27b46b19cc6f00 |
| native-contracts-15.json | 0cb9381b5b915078e8020f32529043a4932b208f94426e492c3f5a2cd625f38b |
| native-contracts-16.json | b2a8ff242bf73287a18ecc0ec42013f317bb2c75d2a6006c82230d6693675e55 |
| native-contracts-17.json | 90925c52576a680925d1ef877782495849530a281bc05771d9b127577fba95e8 |
