---
"@typed-sql/analysis": minor
"@typed-sql/config": minor
"@typed-sql/cli": minor
---

Add explicit live adapter registration and finite native qualification before CLI TypeScript
checking. Qualify every extracted candidate, including successful static inference, through bounded
workers and the persistent scheduler. Check recorded context before and after acquisition, retire
incompatible context evidence, and close owned transport resources before synchronous compilation.

Offline and frozen overrides leave native factories unloaded. Track local modules imported by
explicit contribution factories so subsequent configuration loads detect their changes.
