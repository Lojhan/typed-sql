---
title: Diagnostics
description: Reference typed-sql diagnostic codes, categories, stability, and common resolution paths.
---

# Diagnostics

Automation should depend on diagnostic codes and source ranges, not English message text. The machine-readable registry is exported as `diagnosticRegistry` from `@typed-sql/core`.

| Code | Meaning |
| --- | --- |
| `TSQ001` | SQL syntax could not be parsed. |
| `TSQ002` | SQL exceeded a parser resource limit. |
| `TSQ003` | Conditional SQL exceeded the structural variant limit. |
| `TSQ004` | Structural SQL requires an explicitly trusted fragment. |
| `TSQ005` | Runtime SQL cannot be analyzed statically. |
| `TSQ007` | The schema snapshot and dialect do not match. |
| `TSQ100` | A referenced table does not exist. |
| `TSQ101` | A referenced column does not exist. |
| `TSQ102` | A column reference is ambiguous. |
| `TSQ103` | A relation alias or qualified column is unknown. |
| `TSQ104` | A result expression needs an explicit output name. |
| `TSQ105` | Two result columns produce the same property name. |
| `TSQ106` | A cast target is invalid or unknown. |
| `TSQ107` | An unqualified table name is ambiguous. |
| `TSQ108` | A relation alias is duplicated. |
| `TSQ202` | A function is unknown. |
| `TSQ203` | An operator cannot be inferred safely. |
| `TSQ204` | A function overload is ambiguous. |
| `TSQ205` | A composed parameter has incompatible structural contexts. |
| `TSQ210` | Recursive CTE inference is not supported safely. |
| `TSQ211` | A CTE name is duplicated. |
| `TSQ212` | A CTE does not return rows. |
| `TSQ213` | A CTE column list has the wrong arity. |
| `TSQ214` | `INSERT` source and target arities differ. |
| `TSQ215` | A `JOIN USING` column is not unique on both sides. |
| `TSQ216` | A scalar subquery does not return exactly one column. |
| `TSQ217` | An `IN` subquery does not return exactly one column. |
| `TSQ218` | A statement writes to a column that is not writable. |
| `TSQ219` | An `INSERT` omits a required target column. |
| `TSQ220` | A recursive CTE has an invalid member shape. |
| `TSQ221` | A recursive CTE member uses a prohibited aggregate or window function. |
| `TSQ222` | A named or framed window definition is invalid. |
| `TSQ223` | A window-function invocation uses a prohibited modifier. |
| `TSQ224` | An SQLite UPSERT clause is structurally ambiguous or invalid. |
| `TSQ225` | An SQLite RETURNING expression uses an unavailable result source. |
| `TSQ226` | An UPSERT conflict target does not match a unique constraint. |
| `TSQ227` | An SQLite built-in function invocation has an invalid shape. |
| `TSQ228` | A grouped query or clause contains an aggregate, window, or column reference in an invalid context. |
| `TSQ301` | The live schema or type policy differs from the generated snapshot. |
| `TSQ401` | The dialect surface is intentionally unsupported. |
| `TSQ402` | Exact analysis requires normalized server evidence. |
| `TSQ403` | The recorded server version is outside the supported range. |
| `TSQ404` | The SQL feature is newer than the recorded server version. |
| `TSQ405` | The SQL feature was removed before the recorded server version. |
| `TSQ406` | A required server feature, setting, or capability declaration is absent. |
| `TSQ407` | Recorded server settings make SQL behavior ambiguous. |
| `TSQ500` | Live database metadata differs from compiler evidence. |
| `TSQ501` | A query could not be verified safely or completely. |
| `TSQ502` | Native verification failed; driver details are not persisted. |

## Fixes

A diagnostic may include a structured `SqlDiagnosticFix`. Editor tooling validates its offsets and converts it to the editor's native edit format.

For example, `TSQ004` can offer a preferred “Mark as sql.fragment” fix. The edit adds the explicit trust marker without copying, evaluating, or changing the nested template contents.

## Unknown versus diagnostic

A conservative `unknown` means the SQL can remain valid but typed-sql cannot prove a narrower type. A diagnostic means the configured grammar found invalid, ambiguous, unsafe, stale, or deliberately unsupported behavior.
