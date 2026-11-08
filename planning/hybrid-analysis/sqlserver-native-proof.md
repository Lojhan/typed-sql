# SQL Server native acquisition evidence

The guarded acquisition step passes in [qualification run 42516890437](https://github.com/Lojhan/typed-sql/actions/runs/42516890437)
at commit `28fe8aa7cd14ba6e018376518cfa8fe75ed1537d`. The Linux x64 matrix uses the
repository's pinned engine images and ODBC 18 installation.

| Engine build | Compatibility levels | Reconciled contracts |
| --- | --- | --- |
| 14.0.3560.2 | 140 | 4 |
| 15.0.4500.2 | 140, 150 | 8 |
| 16.0.4305.5 | 140, 150, 160 | 12 |
| 17.0.5035.5 | 140, 150, 160, 170 | 16 |

Each profile describes a canonical bigint parameter, IIF, decimal(38,10) and CONCAT. Candidate
SQL is supplied as a bound metadata-API argument. Independent static reconciliation requires
native runtime-type evidence. Each acquisition uses a fresh exclusive connection and checks the
context before and after description. The probe asserts the actual four-part build and database
compatibility setting. Artifacts contain validated reconciled contracts without candidate SQL.

This proves the restricted expression profile, not general SQL Server query support. Native
relations, qualified routines, custom bindings, installed CLI/build/editor flows and consumer
execution remain outside this proof. The native acquisition modules remain private.

The overall run fails its separate catalog inventory review. Reviewing every captured target
shows only five probe-result corrections from earlier changes: COL_LENGTH and both DB_ID
invocations now retain native smallint identity; DB_ID() stays nullable; both JSON_QUERY
invocations retain nvarchar(4000). All native metadata, inventories, recognition counts and
missing-function observations are unchanged. Reversing only these static result fields exactly
reproduces every previously reviewed full recognition fingerprint across all ten unique
engine/compatibility targets. The reviewed baselines are updated; a fresh complete run is required.
