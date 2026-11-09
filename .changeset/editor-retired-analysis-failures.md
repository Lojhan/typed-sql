---
"@typed-sql/language-server": patch
---

Request a fresh diagnostic snapshot when asynchronous analysis fails after its project generation has been replaced. A late failure can no longer publish a project-unavailable diagnostic over newer analysis.
