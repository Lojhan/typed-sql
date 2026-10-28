---
"@typed-sql/core": patch
---

Reject copied query objects that would otherwise lose value plans or result validators. Keep query composition and validator wrappers owned, and reject compiled plans in the legacy generic executor when no transport decoding contract is available.
