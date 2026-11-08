---
"@typed-sql/analysis": minor
"@typed-sql/language-server": minor
---

Add owned project live-analysis sessions with shared bounded query scheduling, coalesced
request-driven context observations, cancellation and guarded view publication. The language server
uses explicit live adapter registrations, refreshes TypeScript overlays after context changes and
reports connection/observation status. Offline and frozen modes keep native factories unloaded.

Preserve recorded evidence for availability/configuration failures independently of retry policy.
Hybrid analysis may use independent offline rules for unsupported native statement classes;
known changed claims, native rejection and conflicts remain blocking.
