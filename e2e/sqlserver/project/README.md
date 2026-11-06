# Packed SQL Server first-use fixture

`../first-use.mjs` copies this application into an independently installed tarball
consumer. It uses the exact commerce schema from
`examples/sqlserver/schema/001-schema.sql`; `setup.mjs` runs it through the public
ODBC database factory so filtered-index session settings match introspection and
execution.

The replay generates a native snapshot with the installed CLI, generates and checks
SQL declarations, checks inferred inline types, runs strict TypeScript, and builds
inline templates and SQL imports with esbuild. Named attributes, mapped fragments,
conditional fragments and the tutorial's deliberate bigint/string mismatch all
receive checks. Successful native execution asserts bigint identities and exact
decimal text against the seeded rows.

The synchronous verifier and plan inspector register a lazy pool. Each explicit
service lease creates and closes its own configured database connection. The
provider-backed generation phase imports the SDK once; every offline CLI/build
command must leave the importer audit absent. The same offline commands also run
in a second installation without `koffi`, using only the generated snapshot.
This proves offline behavior without asserting a SQL Server file lock.

Only names generated with the `typed_sql_first_use_` prefix and a validated random
hex suffix can be created or dropped. Credentials arrive through environment
variables and are redacted from artifacts. Native replay requires the Linux x64
qualification environment; a local offline replay alone is not native evidence.

The installed CLI also generates a fresh manifest, runs `verify --live`, validates
`nativeTypeComparison: true` and a verified named SQL asset, then checks the same
cached proof twice with zero SDK imports and unchanged proof bytes. Native
`explain` must capture a structured plan for that asset in `value-free` mode,
without sample fingerprints. Mapped-query skips retain explicit reasons; native
metadata mismatches and capture errors fail the replay. Provider, manual service,
live CLI and plan CLI import audits are separate phases, with no assumed cache
connection count. Per-phase redacted artifacts retain proof and plan evidence.
