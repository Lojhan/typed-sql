---
"@typed-sql/core": major
"@typed-sql/postgres": major
"@typed-sql/mysql": major
---

Add grammar-neutral optional adapter capability discovery, typed PostgreSQL COPY import and export
through application-owned `pg-copy-streams`, and typed MySQL LOAD DATA import through mysql2's
application-owned infile stream. Bulk transfers preserve ordinary `INSERT` parameter evidence,
enforce structural row stability, apply bounded backpressure, support cancellation and progress,
and integrate with transaction ownership and conservative connection cleanup.
