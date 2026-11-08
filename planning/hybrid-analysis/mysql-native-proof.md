# MySQL native contract qualification

The acquisition adapter owns a fresh MySQL2 connection, an instance backup lock and a read-only
transaction. It sends candidate SQL only through binary preparation, obtains ordered parameter
and result descriptors, closes the prepared handle and releases the owned connection. It neither
binds sample values nor executes candidate SQL.

## Guarded table-query scope

The profile supports builtin expression projections plus ordinary InnoDB table projections,
stars, filters and joins. References stay in the selected database with `lower_case_table_names=0`;
name matching does not approximate filesystem or Unicode case rules for other modes. Views,
non-InnoDB engines, generated columns, explicit partition selectors, subqueries, CTEs, compounds,
grouping, ordering/limits and window clauses remain unavailable. Stored and loadable routines
remain excluded, including server-collation aliases that ASCII folding alone cannot reject.

Native table/column dictionary records are captured under the backup lock and enter the context
digest. The bounded snapshot admits 4,096 visible tables and 65,536 visible columns. Overflow
fails closed rather than truncating evidence. The selected dictionary fields omit row counts,
auto-increment counters and engine data statistics, preserving identity across ordinary DML.
They retain column order, types, nullability, defaults, collation, extra flags and generation
expressions, so table-DDL changes invalidate an old contract even with an unchanged supplied schema.
Adapter/profile v2 distinguish this acquisition and context policy from the earlier expression scope.

Star expansion removes positional correspondence with some projection AST nodes. Exact prefix
and suffix positions retain numeric-literal bounds, while slots between stars do not borrow a
bound from a guessed position. A later `1` cannot turn an expanded BIGINT column into a JavaScript
number. Native field metadata remains authoritative for unanchored slots.

## Pinned engine/source evidence

The real table helper runs on MySQL 8.4.11 and 9.7.2. The official prepared-statement implementations
for [8.4.11](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_prepare.cc#L25) and
[9.7.2](https://github.com/mysql/mysql-server/blob/mysql-9.7.2/sql/sql_prepare.cc#L25) distinguish
COM_STMT_PREPARE metadata production from later execution. Preparation opens referenced tables;
this is why the adapter checks the storage engine and relation kind before preparing a candidate.

The selected INFORMATION_SCHEMA fields come from dictionary-backed views: see the official
[8.4 table view](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/dd/impl/system_views/tables.cc#L32),
[8.4 column view](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/dd/impl/system_views/columns.cc#L33)
and [9.7 table view](https://github.com/mysql/mysql-server/blob/mysql-9.7.2/sql/dd/impl/system_views/tables.cc#L31).
The snapshot selects static definitions and avoids engine statistics fields. The
[backup lock contract](https://dev.mysql.com/doc/refman/8.4/en/lock-instance-for-backup.html)
requires BACKUP_ADMIN, permits DML and blocks conflicting DDL. PREPARE's own metadata locks
end after preparation; the adapter retains its separate backup lock for the acquisition window.

## Real-engine checks

`assertMySqlTableContracts` creates owned fixtures and verifies:

- Column projections and a left join obtain BIGINT result and independently inferred input types.
  An ordinary CURRENT_DATE expression default remains admissible despite its DEFAULT_GENERATED flag.
- An advisory-lock predicate does not acquire its lock, checked from a second connection before
  the native description session closes.
- A view containing a side-effecting stored function, a direct stored-function call, a MEMORY
  table and a generated-column table fail admission; the side-effect counter stays unchanged.
- Star expansion preserves column order and decimal dimensions, and actual execution through
  the recorded value plan decodes 9007199254740993 exactly as bigint. Trailing numeric literals
  retain number bounds and reconcile successfully; actual execution also covers the BIGINT
  string policy without converting integer column values to numbers.
- A builtin invocation over a table column reconciles with independent offline analysis and
  compiles from a serialized contract in a frozen host without loading an analyzer there.
- Ordinary DML preserves context identity; a concurrent ALTER TABLE times out under the owned
  backup lock and succeeds after close, changing the next captured context.

The existing full native helper additionally checks cancellation/deadlines, routine/UDF aliases,
cache reuse/regeneration, engine-specific availability, native/static conflicts and offline export.
Its installed-host fixture now uses table queries too. Fresh tarball installations on both target
engines exercise CLI generation, frozen SQL-file declarations and TypeScript checking, bundling
and actual query execution, unsaved SQL/TypeScript editor regeneration, independent routine/table
DDL observation and cache-only process restart with durable inputs hidden. This covers the named
table-query shapes; it does not establish whole-grammar coverage.

## Planned scalar decoding

The new star regression exposed a host mismatch: a small numeric literal can have a BIGINT wire
family while its qualified logical representation is number. MySQL transport normalization now
uses the scalar descriptor to retain that bound under bigint and string policies. Unsafe numbers
and numeric-looking VARCHAR values still fail validation. Core passes the optional descriptor to
normalization hooks, and portable SQLite wrappers forward it; two-argument hooks remain valid.
Buffered and streamed tests cover safe normalization, overflow rejection and unchanged unplanned
BIGINT policy behavior. Prefix/suffix projection anchors preserve proven literal bounds without
guessing positions between stars.
