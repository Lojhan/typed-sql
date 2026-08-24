# Diagnostic codes

Diagnostic meanings become stable at 1.0. New codes may be added in minor releases; removing a code
or changing its meaning requires a major release. The machine-readable registry is exported as
`diagnosticRegistry` from `@typed-sql/core`.

| Range | Meaning |
| --- | --- |
| `TSQ001` | SQL syntax error |
| `TSQ002` | Parser resource limit exceeded |
| `TSQ007` | Dialect/snapshot contract mismatch |
| `TSQ100`–`TSQ108` | Catalog lookup, ambiguity, output naming, and cast errors |
| `TSQ202`–`TSQ204` | Unknown/ambiguous functions and unsafe operator inference |
| `TSQ210`–`TSQ217` | CTE, DML arity, join, and subquery safety errors |
| `TSQ301` | Schema or type-policy drift |
| `TSQ401` | Deliberately unsupported dialect surface |

Consumers should key automation on `code`, not English message text. Severity, source range, and an
optional safe suggestion remain part of every diagnostic.
