---
"@typed-sql/compiler": patch
---

Allow bundlers to remove unselected generated SQL-file modules through barrel exports without requiring application sideEffects metadata. Validate value plans during compilation before marking successful static initializers pure. Selected query factories retain their decoding plans and parameter checks; invalid SQL modules keep their throwing behavior.
