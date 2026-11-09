---
"@typed-sql/analysis": patch
---

Retry explicitly classified native context-observation races up to three times within the existing live-session deadline. Failed observations retire prior evidence, and fresh attempts capture a new publication fence; permission failures and malformed evidence are not retried.
