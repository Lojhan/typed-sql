# Compatibility and performance

| Surface | Supported/tested contract |
| --- | --- |
| Node.js | 22.11 or newer; CI uses 22.11 and release publishing uses 24 |
| pnpm | 10.32.1 |
| TypeScript correctness path | exactly 7.0.2 |
| TypeScript preview bridge | exactly 7.1.0-dev.20260824.1 |
| PostgreSQL | real E2E on official PostgreSQL 18.4 |
| MySQL | real E2E on official MySQL 8.4.11 |
| pg | E2E application owns 8.23.0 |
| @types/pg | PostgreSQL package supplies declarations-only 8.23.1; no runtime driver is installed |
| mysql2 | E2E application owns 3.24.1 |

The compiler performance gate transforms 1,000 static query templates in at most 3,000ms on an
unwarmed CI-compatible Node process. Parser fuzzing runs 2,000 deterministic arbitrary inputs.
Compiler-critical packages enforce at least 95% statements, lines, and functions plus 90% branches.
Editor analysis additionally bounds caches and initial workspace scanning.

TypeScript 7.0 intentionally has no stable embeddable API. Therefore CLI checks and source
transforms are authoritative, while the preview bridge is isolated behind a process boundary and
can be replaced without changing the grammar or generated-query contract.
