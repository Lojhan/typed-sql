---
"@typed-sql/language-server": patch
---

Make external editor startup reproducible from the installed package. Route multi-root workspaces
through independent grammar/config/schema services, keep generated schema reloads synchronized with
the TypeScript overlay, guard preview process failures with actionable errors, and launch the packed
language-server executable in PostgreSQL and MySQL editor smoke tests.
