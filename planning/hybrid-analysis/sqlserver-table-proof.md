# SQL Server guarded table query contracts

The v2 adapter admits projections, stars, filters and ordinary joins over explicit two-part local
table names. It resolves identifiers with bound `OBJECT_ID(QUOTENAME(?) + N'.' + QUOTENAME(?))`
metadata rather than JavaScript case folding or SQL identifier interpolation. Unqualified,
cross-database and remote names remain unavailable in this profile.

Captured table flags, column capabilities and security predicates participate in context identity.
Before description, each resolved object must be an ordinary local stored table with known system
column types. Views/synonyms, external, temporal, memory-optimized, FileTable, remote archive and
graph relations are excluded. So are computed, hidden, generated, encrypted, typed-XML and
alias/CLR columns and any table with security predicates, including disabled policies. Catalog
capture rejects more than 65,536 columns or 20,000 rows in another captured collection.

The existing database/recovery/connection/session/log guards run around capture, name resolution
and description. Any concurrent logged activity conservatively invalidates the observation;
this is not a transaction that blocks all DDL or a dependency-specific invalidation mechanism.
Description uses the native metadata APIs, with candidate SQL bound as data. It never executes
the candidate, samples rows or changes user database settings. SQL Server performs static
analysis in its description APIs; this is not a claim that compilation performs no internal work
or that an arbitrary external provider can safely be admitted.

Primary references:

- [Description API and static analysis](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-describe-first-result-set-transact-sql)
- [Table capabilities](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-tables-transact-sql)
- [Column capabilities](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-columns-transact-sql)
- [Security predicates](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-security-predicates-transact-sql)

Local evidence: all 24 SQL Server test files and their coverage gate pass, as do workspace type
checks. Regression tests exercise bound quoted identifiers, context changes, unsafe/incomplete
catalog evidence and log drift during relation resolution before candidate description.

Real qualification is pending. The Linux x64 workflow now tests table parameter inference,
join/decimal/star metadata and actual view/computed/alias/RLS rejection at every declared
compatibility level on the four pinned engines. Its installed host fixture now uses a joined table
query for generation, frozen declarations/execution, unsaved SQL/TypeScript editor regeneration,
table-DDL observation, cache-only restart and disconnected frozen builds.
