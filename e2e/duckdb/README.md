# DuckDB packed consumers

The isolated consumers exercise the qualified native SDK profiles, compiled SQL and inline queries,
CLI/build integrations, exact nested values, verification, query plans and native appends. Offline
commands run while another process holds the database's write lock, including an installation
without the optional SDK. A separate provider-backed generation step intentionally opens the database
after releasing the lock. Evidence is written under `artifacts/duckdb/packed`.

See the canonical [DuckDB guide](https://github.com/Lojhan/typed-sql/blob/main/docs/dialects/duckdb.md)
and [quickstart](https://github.com/Lojhan/typed-sql/blob/main/docs/getting-started/duckdb.md).
