---
"@typed-sql/language-server": patch
---

Validate the bundled TypeScript preview entrypoint before proxy initialization so a missing or corrupted installation reports the actionable recovery diagnostic instead of an `EPIPE` process failure.
