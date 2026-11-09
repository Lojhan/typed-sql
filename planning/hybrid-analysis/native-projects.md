# Native commerce workload measurements

Actual owned databases are provisioned from the maintained commerce schemas, introspected and removed before offline replay. The JSON retains committed producer hashes, corpus inputs, query outcomes and native qualification evidence. These are bounded workload observations, not grammar coverage or function popularity.

## Base workload

| Profile | Finite queries | Admitted | Qualified | Declined | Other acquisition outcomes | Unbounded files |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| duckdb-commerce-1.5.6 | 8 | 1 | 1 | 7 | 0 | 1 |
| duckdb-commerce-2.0.0 | 8 | 1 | 1 | 7 | 0 | 1 |
| mysql-commerce-8.4.11 | 7 | 1 | 1 | 6 | 0 | 1 |
| mysql-commerce-9.7.2 | 7 | 1 | 1 | 6 | 0 | 1 |
| postgres-commerce-18.3 (Debian 18.3-1.pgdg13+1) | 7 | 1 | 0 | 6 | 1 | 1 |
| sqlite-commerce-3.53.4 | 7 | 4 | 4 | 3 | 0 | 1 |
| sqlserver-commerce-14-140 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-15-140 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-15-150 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-16-140 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-16-150 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-16-160 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-17-140 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-17-150 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-17-160 | 8 | 0 | 0 | 8 | 0 | 1 |
| sqlserver-commerce-17-170 | 8 | 0 | 0 | 8 | 0 | 1 |

Missing grammar measurements: none. Only the explicitly listed engine versions and compatibility profiles are measured.

## Qualified subset scaling

| Profile | Copies | Qualified / finite | Durable bytes | Cache bytes | Acquire and publish ms | Offline reload and check ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| duckdb-commerce-1.5.6 | 1 | 1 / 8 | 12825 | 13473 | 295.67 | 39.13 |
| duckdb-commerce-1.5.6 | 10 | 10 / 80 | 121662 | 125272 | 1461.91 | 356.18 |
| duckdb-commerce-1.5.6 | 50 | 50 / 400 | 605382 | 622152 | 6595.59 | 1694.48 |
| duckdb-commerce-2.0.0 | 1 | 1 / 8 | 12825 | 13473 | 328.04 | 47.03 |
| duckdb-commerce-2.0.0 | 10 | 10 / 80 | 121662 | 125272 | 1722.08 | 386.36 |
| duckdb-commerce-2.0.0 | 50 | 50 / 400 | 605382 | 622152 | 7842.73 | 1906.67 |
| mysql-commerce-8.4.11 | 1 | 1 / 7 | 12224 | 12872 | 118.19 | 17.31 |
| mysql-commerce-8.4.11 | 10 | 10 / 70 | 115661 | 119271 | 554.90 | 99.82 |
| mysql-commerce-8.4.11 | 50 | 50 / 350 | 575381 | 592151 | 2459.80 | 428.44 |
| mysql-commerce-9.7.2 | 1 | 1 / 7 | 12224 | 12872 | 112.12 | 20.35 |
| mysql-commerce-9.7.2 | 10 | 10 / 70 | 115661 | 119271 | 521.32 | 104.44 |
| mysql-commerce-9.7.2 | 50 | 50 / 350 | 575381 | 592151 | 2487.67 | 371.20 |
| postgres-commerce-18.3 (Debian 18.3-1.pgdg13+1) | 1 | 0 / 7 | 123 | 506 | 298.30 | 2.53 |
| postgres-commerce-18.3 (Debian 18.3-1.pgdg13+1) | 10 | 0 / 70 | 123 | 506 | 1071.20 | 3.20 |
| postgres-commerce-18.3 (Debian 18.3-1.pgdg13+1) | 50 | 0 / 350 | 123 | 506 | 4818.42 | 4.04 |
| sqlite-commerce-3.53.4 | 1 | 4 / 7 | 41129 | 42764 | 463.69 | 53.33 |
| sqlite-commerce-3.53.4 | 10 | 40 / 70 | 404738 | 418218 | 3641.95 | 302.00 |
| sqlite-commerce-3.53.4 | 50 | 200 / 350 | 2020778 | 2086899 | 17808.82 | 1499.40 |
| sqlserver-commerce-14-140 | 1 | 0 / 8 | 123 | 506 | 732.00 | 30.21 |
| sqlserver-commerce-14-140 | 10 | 0 / 80 | 123 | 506 | 346.48 | 33.10 |
| sqlserver-commerce-14-140 | 50 | 0 / 400 | 123 | 506 | 385.92 | 32.44 |
| sqlserver-commerce-15-140 | 1 | 0 / 8 | 123 | 506 | 724.92 | 46.09 |
| sqlserver-commerce-15-140 | 10 | 0 / 80 | 123 | 506 | 359.59 | 17.44 |
| sqlserver-commerce-15-140 | 50 | 0 / 400 | 123 | 506 | 388.12 | 33.06 |
| sqlserver-commerce-15-150 | 1 | 0 / 8 | 123 | 506 | 699.68 | 42.19 |
| sqlserver-commerce-15-150 | 10 | 0 / 80 | 123 | 506 | 342.92 | 10.17 |
| sqlserver-commerce-15-150 | 50 | 0 / 400 | 123 | 506 | 400.67 | 25.47 |
| sqlserver-commerce-16-140 | 1 | 0 / 8 | 123 | 506 | 754.05 | 5.55 |
| sqlserver-commerce-16-140 | 10 | 0 / 80 | 123 | 506 | 315.59 | 40.71 |
| sqlserver-commerce-16-140 | 50 | 0 / 400 | 123 | 506 | 363.34 | 37.98 |
| sqlserver-commerce-16-150 | 1 | 0 / 8 | 123 | 506 | 732.96 | 47.54 |
| sqlserver-commerce-16-150 | 10 | 0 / 80 | 123 | 506 | 468.48 | 9.12 |
| sqlserver-commerce-16-150 | 50 | 0 / 400 | 123 | 506 | 429.86 | 27.28 |
| sqlserver-commerce-16-160 | 1 | 0 / 8 | 123 | 506 | 732.55 | 19.83 |
| sqlserver-commerce-16-160 | 10 | 0 / 80 | 123 | 506 | 359.90 | 26.66 |
| sqlserver-commerce-16-160 | 50 | 0 / 400 | 123 | 506 | 383.92 | 26.30 |
| sqlserver-commerce-17-140 | 1 | 0 / 8 | 123 | 506 | 975.66 | 27.68 |
| sqlserver-commerce-17-140 | 10 | 0 / 80 | 123 | 506 | 507.44 | 28.63 |
| sqlserver-commerce-17-140 | 50 | 0 / 400 | 123 | 506 | 496.42 | 38.52 |
| sqlserver-commerce-17-150 | 1 | 0 / 8 | 123 | 506 | 885.46 | 39.38 |
| sqlserver-commerce-17-150 | 10 | 0 / 80 | 123 | 506 | 432.14 | 3.85 |
| sqlserver-commerce-17-150 | 50 | 0 / 400 | 123 | 506 | 501.76 | 26.12 |
| sqlserver-commerce-17-160 | 1 | 0 / 8 | 123 | 506 | 893.30 | 25.39 |
| sqlserver-commerce-17-160 | 10 | 0 / 80 | 123 | 506 | 443.16 | 18.85 |
| sqlserver-commerce-17-160 | 50 | 0 / 400 | 123 | 506 | 482.44 | 24.99 |
| sqlserver-commerce-17-170 | 1 | 0 / 8 | 123 | 506 | 903.61 | 34.53 |
| sqlserver-commerce-17-170 | 10 | 0 / 80 | 123 | 506 | 434.33 | 31.14 |
| sqlserver-commerce-17-170 | 50 | 0 / 400 | 123 | 506 | 486.35 | 13.68 |

Artifact sizes apply to the qualified subset only. An empty closure is still a manifest; its bytes do not represent application support. Every measured project remains incomplete wherever writes, unsupported statement forms, context restrictions or unbounded rendering prevent native qualification. Zero native calls during offline replay proves reuse of the exported subset, including no useful contracts when qualification is zero.

Timings are single serial observations, not percentiles or engine rankings. Acquisition/publication excludes fixture provisioning, introspection, compression, artifact byte reads and offline replay. Copies add SQL comments to exercise distinct exact-query identities; they do not add distinct business logic or database objects. Runtime bundles, package installation, schema size and external engines/drivers are separate costs. Native facets remain subject to each recorded qualification policy; qualifying runtime types does not establish exact native identities or nullability.

Machine evidence: [native-project-measurements.json](./native-project-measurements.json). Reproduce using the owner `measure-*-commerce.mjs` tools, then run `node --import tsx planning/hybrid-analysis/summarize-native-projects.mjs <report.json> ...`. Server-backed tools require explicit audit connection environment variables and create/drop only their own randomly named databases. SQL Server measurements run in its hosted qualification workflow.
