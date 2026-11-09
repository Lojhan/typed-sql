---
"@typed-sql/core": minor
"@typed-sql/adapters": patch
"@typed-sql/mysql": patch
---

Pass the optional scalar descriptor to transport normalization hooks, preserving existing two-argument
hooks. Forward the descriptor through SQLite adapter wrappers. Use integer metadata to decode
qualified MySQL numeric literals consistently under lossless BIGINT policies while rejecting unsafe
numbers and unrelated numeric-looking text.
