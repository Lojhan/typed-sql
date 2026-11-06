# SQL Server catalog and session audit

Internal implementation evidence and native qualification proposals. These are not additional public support claims.

## Session attestation implemented

`SqlServerConnectionLike.readServerEvidence(controls)` is an optional grammar-owned native hook. The runtime invokes it inside its existing lease before each typed buffered/prepared dispatch, at transaction entry, and before starting a lazy stream. The explicit native factory supplies the hook using unlocked protocol requests. A generic injected connection without the hook retains application-attested evidence.

The runtime freezes the creation evidence and compares product, exact build/version key, database name, schema, compatibility level, collation, engine edition and the modeled critical SET/date/language facts. It first rechecks that the actual facts satisfy runtime qualification. Drift rejects before typed SQL executes; it does not silently configure or switch databases. Transaction cleanup, unprepare, raw catalog/setup operations and explicit close bypass this typed check. In particular, a metadata tool can issue `SET SHOWPLAN_XML OFF` without recursively acquiring the runtime lease or trying to read metadata while SHOWPLAN is active. A stream closed during an in-flight evidence read never creates its native cursor afterwards. Its private read receives a stream-owned cancellation signal, and close holds the lease until the read's native terminal cleanup settles. Buffered calls propagate the caller's signal and absolute deadline through both private native evidence reads; pre-aborted/expired calls perform no evidence or application SQL. Controls are checked again before application dispatch, including after a hook that ignores its controls. Generic injected hooks remain responsible for honoring controls while they are pending.

The direct production protocol now propagates controls through `prepare(sql, controls)` and qualifies available metadata before buffered or streamed typed execution. The compatibility driver's preparation RPC does not expose cancellation; controlled logical queries therefore use its qualified raw path. Direct FFI controls cover prepare/describe/bind/execute/fetch/drain and settle worker epochs before lease release. No immediate interruption or safe worker termination is inferred from a timer firing.

Tests cover supported-but-different compatibility levels, unsupported future engines/Azure editions, canonical-setting changes, raw repair, transaction rollback, lazy stream cancellation, shared ownership during the native read, and generic injection without the hook. Native production qualification still needs to repeat changes through real `SET`, database `USE`, and supported compatibility changes on the same actual connection. Concurrent application use of an injected native handle outside the wrapper remains an application ownership violation, not something two sequential catalog reads can make atomic.

## Catalog findings and fixes

- `timestamp` is normalized to `rowversion`, with native binary storage retained. Column INSERT/UPDATE eligibility already rejects it. Native adapter metadata must preserve the SQL type name so it is not confused with an ordinary writable `binary(8)` column.
- Identity, computed persisted/virtual, generated-always temporal/ledger fields, hidden fields and encrypted columns retain separate facts. Identity/generated/computed/encrypted values are not writable through ordinary typed parameter assignment. Unknown view write eligibility remains explicit; it is not evidence that every view supports DML.
- Alias types preserve a native base type and an alias identity. `sys.types.is_nullable` is the type's declared default, while `sys.columns.is_nullable` is the actual column fact. SQL Server explicitly permits a table declaration to override alias NULL/NOT NULL. This is not a PostgreSQL domain constraint.
- Formerly default detection used only `sys.default_constraints.definition`, silently losing standalone defaults and alias-bound defaults. The query now retains column and type `default_object_id`/`rule_object_id` separately, obtains visible definitions through `OBJECT_DEFINITION`, records only fingerprints, and treats a known column default object with unavailable definition as present. A type-bound default alone leaves column default applicability unknown: `sp_bindefault`/`sp_bindrule` support `futureonly`, so a provider must not infer that every existing column inherits a new type binding. Alias declarations retain their own bound IDs, declared nullability and available fingerprints.
- Active history tables (`sys.tables.temporal_type=1`) formerly exposed writable ordinary columns. Their relation INSERT/UPDATE/DELETE capabilities and column write flags are now false; resolver diagnostics reject direct history DML. Detached histories return to ordinary table status (`temporal_type=0`). Current system-versioned tables remain writable outside their generated period columns. `FOR SYSTEM_TIME` requires qualified system-versioned-table evidence.

## Native cases to run on every qualified major

Use a fresh disposable database and separate batches where CREATE DEFAULT/RULE requires it. Do not execute this setup in an application database. Keep all CREATE text out of published snapshots; assert fingerprints instead.

```sql
CREATE TYPE dbo.qualification_alias FROM bigint NOT NULL;
CREATE DEFAULT dbo.qualification_default AS 7;
CREATE RULE dbo.qualification_positive AS @value > 0;
EXEC sys.sp_bindefault N'dbo.qualification_default', N'dbo.qualification_alias';
EXEC sys.sp_bindrule N'dbo.qualification_positive', N'dbo.qualification_alias';
CREATE TABLE dbo.qualification_catalog (
  id bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
  inherited_value dbo.qualification_alias,
  nullable_override dbo.qualification_alias NULL,
  amount decimal(38,10) NOT NULL DEFAULT(0),
  computed_virtual AS (id+1),
  computed_stored AS (id+2) PERSISTED,
  version_value rowversion
);
```

Assert actual type identities and dimensions, type nullable=false, overridden column nullable=true, inherited column nullable=false, alias-bound default presence and rule IDs, native identity seed/increment, computed flags, and rowversion nonwritability. Execute an INSERT omitting inherited_value and verify 7; execute alias-compatible bound parameters using the bigint physical target; distinguish native rule failure from transport loss. Capture native rowversion as exact eight bytes and compare with a server-side cast in the same row. Do not infer that the alias forces NOT NULL after an explicit nullable column override.

Add a column-level standalone default and a column-level bound rule to prove column binding precedence over type binding. Query actual sys.columns/sys.types IDs rather than assuming both catalogs duplicate the same binding IDs. Reintrospect after unbinding and compare presence/fingerprints. Also create one alias column before binding with `futureonly` and one afterwards; capture exact sys.columns and sys.types IDs and execute omitted-value INSERTs. This distinguishes actual inherited column defaults from a type default that intentionally does not apply to an older column.

```sql
CREATE TABLE dbo.qualification_temporal (
  id bigint NOT NULL PRIMARY KEY,
  status nvarchar(40) NOT NULL,
  valid_from datetime2(7) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
  valid_to datetime2(7) GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,
  PERIOD FOR SYSTEM_TIME(valid_from,valid_to)
) WITH (SYSTEM_VERSIONING=ON(HISTORY_TABLE=dbo.qualification_history));
```

Assert current/history `temporal_type=2/1`, linked history object ID, hidden period column ordering and write flags. Run ordinary current INSERT/UPDATE/DELETE with exact OUTPUT values; verify period assignments fail and direct history INSERT/UPDATE/DELETE fail natively and analytically. Verify `FOR SYSTEM_TIME AS OF` yields the expected native row types. Turn SYSTEM_VERSIONING OFF, reintrospect, and verify history write capability changes from false to true. Explicitly remove versioning before fixture cleanup.

## Permissions and remaining evidence limits

Database VIEW DEFINITION is required. It is not a proof that all object definitions are visible: object-level DENY can override broader grants, definitions can be encrypted, and a low-privilege catalog can omit rows entirely. A snapshot must not claim that invisible definitions are absent. The default-presence fix addresses the observable nonzero-ID/null-definition case. Existing routine `definitionUnavailable`, opaque transport and unknown view write flags remain conservative.

Native permission controls should use a dedicated WITHOUT LOGIN principal: grant database VIEW DEFINITION, demonstrate ordinary visibility, deny object VIEW DEFINITION, and inspect effective permissions, row visibility and definition NULLs before attempting provider capture. Repeat without database VIEW DEFINITION and assert rejection. Compare with an owner capture to detect omitted rows; do not call the restricted capture complete. Whether to add a per-object VIEW DEFINITION probe or require a privileged capture principal for complete catalogs remains an explicit policy question: a per-visible-object check alone cannot reveal an entirely invisible securable. No permission escalation or automatic GRANT is performed by introspection.

Other residual topics: catalog capture across concurrent DDL is not an atomic schema snapshot; legacy bound rules are retained as opaque evidence, not evaluated to narrow row values; updatable view proof would need native per-column result metadata and trigger/operation evidence; CLR, encrypted and table-valued native codecs remain unsupported without explicit qualification.

## Primary evidence

- [sys.columns: standalone/default/rule object identities](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-columns-transact-sql)
- [sys.types: alias nullability and bound defaults/rules](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-types-transact-sql)
- [CREATE TABLE: alias nullability overrides](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql)
- [Metadata visibility and DENY precedence](https://learn.microsoft.com/en-us/sql/relational-databases/security/metadata-visibility-configuration)
- [Temporal restrictions on generated columns and direct history modification](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-table-considerations-and-limitations)
- [Temporal security: direct history writes forbidden while versioning is on](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-table-security)

- [sp_bindefault: futureonly prevents inheritance by existing columns](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-bindefault-transact-sql)
