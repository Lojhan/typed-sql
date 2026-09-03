---
"@typed-sql/ast": minor
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
---

Add the grammar-neutral parser toolkit and move first-party parsing, ASTs, tokenization, and walking into each grammar package. The historical multi-dialect AST parser is isolated as a deprecated typed-sql 2.x compatibility surface for removal in 3.0.
