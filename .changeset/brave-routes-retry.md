---
"@typed-sql/ast": minor
"@typed-sql/core": major
"@typed-sql/postgres": major
"@typed-sql/mysql": major
---

Add conservative semantic primary/replica routing over application-owned databases, scoped
read-after-write pinning, explicit role requirements, stable unsafe-route errors, dialect runtime
semantic resolvers, and bounded abortable transaction retry policies with native PostgreSQL and
MySQL error classifiers. Parse and classify dialect locking reads so uncertain or affine work
always fails closed to primary.
