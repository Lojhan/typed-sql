---
"@typed-sql/analysis": minor
"@typed-sql/cli": minor
---

Add explicit live/offline query-contract generation and check-only export comparison. Generation
checks the prospective contract view with TypeScript and fences source/config/schema/project inputs
before publishing a complete durable closure. Native-required qualification cannot fall back to an
ordinary offline result.

Serialize cooperating exporters, compare the selected manifest before replacement, and reject
unsafe artifact files. Preserve recorded result kind and reject offline materialization that would
lose logical type refinements or misrepresent partial native identity.
