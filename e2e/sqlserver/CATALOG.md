# SQL Server native catalog qualification

This private probe tests the production `@typed-sql/sqlserver/odbc` transport, actual `sys.*` facts,
provider snapshots, generated SQL-file factories and native DML. It creates a uniquely named
disposable database for each compatibility level from 140 through the selected engine's ceiling.
It changes no existing application database. Cleanup removes only databases created by this run.

Run it in the qualification workflow's pinned Linux x86-64 environment after building the packages:

```sh
TYPED_SQL_SQLSERVER_MAJOR=17 \
TYPED_SQL_SQLSERVER_BUILD=17.0.5035.5 \
TYPED_SQL_SQLSERVER_PASSWORD='<disposable sa password>' \
pnpm --dir e2e/sqlserver exec node catalog-probe.mjs
```

Use the matrix's actual pinned build for each major; the probe asserts both native build and
compatibility evidence. The root qualification workflow owns engine provisioning and invocation.
This file does not assert that a locally syntax-checked probe has completed native qualification.

The independent cases cover:

- Alias base/type identities, actual column nullability overrides, bound default/rule object IDs,
  column binding precedence, unbinding, native identity seed/increment, computed fields and exact
  rowversion bytes. Generated factories bind the alias through its bigint physical type, including
  bigint's positive limit, and distinguish native rule violations from connection loss.
- `futureonly` binding on old versus newly declared alias columns, actual omitted-value behavior,
  and rules that apply to the new column without narrowing the old column's bigint values.
- Current/history temporal identities, hidden period columns, native and static write restrictions,
  exact current DML/OUTPUT, native literal and compiled parameterized `AS OF`, and history DML after
  detaching versioning. A parameterized `AS OF` counterexample is recorded without preventing later
  history restriction/detach observations; it still fails qualification overall.
- The repository's actual seven-table commerce DDL, native table/index intake and generated joined
  query execution.
- A dedicated `WITHOUT LOGIN` principal with database `VIEW DEFINITION`, object-level denials,
  a visible but definition-unavailable function, observable default visibility, and provider
  rejection after revoking database `VIEW DEFINITION`.

Evidence goes to `artifacts/sqlserver/catalog-<major>.json`. It records synthetic native IDs,
flags, constraint SQLSTATE/native codes, observations and failures. Snapshot expression text stays
hashed. It never writes credentials or makes a restricted snapshot a completeness proof. Effective
object denials, omitted owner-visible relations and unavailable definitions are explicit limitations;
no per-visible-object check can establish the absence of entirely invisible securables.

The [catalog audit](../../planning/new-grammars/sqlserver-catalog-audit.md) records the modeled facts
and unresolved visibility policy. Microsoft documents the
[alias binding/unbinding behavior](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-unbindefault-transact-sql?view=sql-server-ver17)
and [rule unbinding behavior](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-unbindrule-transact-sql?view=sql-server-ver17).
