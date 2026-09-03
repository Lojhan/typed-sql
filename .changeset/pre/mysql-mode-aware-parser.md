---
"@typed-sql/mysql": minor
---

Apply normalized MySQL SQL modes before scanning. `ANSI_QUOTES`, `NO_BACKSLASH_ESCAPES`, and
`PIPES_AS_CONCAT` now select exact lexical behavior, and executable server comments fail closed.
