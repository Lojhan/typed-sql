---
"@typed-sql/mysql": patch
"@typed-sql/postgres": patch
---

Own in-flight transaction executions through settlement so unawaited work can never race commit, savepoint release, rollback, or connection release.

The PostgreSQL adapter now also rejects pg's client-side `query_timeout` option because it can settle before the connection is safe to reuse. Root batches discard checked-out clients after query rejection, while caught transaction query, batch, and stream failures force rollback and discard the lease. Use PostgreSQL's server-enforced `statement_timeout` for statement deadlines.
