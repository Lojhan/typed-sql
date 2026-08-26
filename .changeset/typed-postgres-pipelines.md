---
"@typed-sql/postgres": minor
---

Add an exactly typed PostgreSQL `pipeline()` capability backed by node-postgres's documented opt-in pipeline mode. Pipelines lease one client, dispatch independent queries before awaiting their results, preserve tuple order and prepared metadata, settle every in-flight query before cleanup, and integrate with transaction rollback and non-escape guarantees without changing sequential `batch()` semantics.
