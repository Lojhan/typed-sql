---
"@typed-sql/analysis": patch
---

Apply bounded automatic context refresh when a native adapter reports guard drift while observing initial or final context metadata. Fresh attempts share the existing batch deadline and start only after cleanup. Pinned contexts, cancellation, malformed metadata and cleanup failures remain blocking.
