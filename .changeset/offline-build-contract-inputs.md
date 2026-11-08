---
"@typed-sql/analysis": minor
"@typed-sql/build": minor
"@typed-sql/compiler": minor
"@typed-sql/cli": minor
---

Consume durable query contracts in build transforms and SQL declaration generation. Frozen builds use recorded inputs without initializing analyzers or native services. Offline and live-configured builds can use offline rules for unrecorded queries; builds never invoke live factories or read the disposable development cache. Track the validated contract closure in cache keys and watched dependencies, including lazy analyzer dependencies in source-aware Jest keys, and reject inputs changed during preparation or publication.

Explicit query-contract generation checks prospective SQL types over stale build-owned declarations in memory, allowing changed queries to regenerate their contracts before declarations are rewritten. Application-owned declarations and incorrect application assignments remain blocking; ordinary checks still reject stale declarations.
