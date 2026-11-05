# SQL Server qualification

`pnpm --filter @typed-sql/e2e-sqlserver qualify:transport` runs native ODBC transport probes
against a disposable SQL Server. Use the CI workflow's pinned Linux x86-64 environment for
server qualification. Evidence contains version/settings and synthetic values, never credentials.

The internal [implementation plan](../../planning/new-grammars/implementation-plan.md) records
qualification gates. See [type policies](../../docs/reference/type-mappings.md) for the shared
compile-time/runtime consistency contract.
