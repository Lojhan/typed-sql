---
"@typed-sql/config": patch
---

Reuse a bounded content-addressed config module cache so repeated project and editor lifecycles do not retain a new TypeScript loader for unchanged configuration.
