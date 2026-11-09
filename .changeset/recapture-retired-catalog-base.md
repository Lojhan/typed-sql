---
"@typed-sql/analysis": patch
---

Retry automatic project-catalog capture for explicitly classified native guard drift and when its base cache evidence is retired before publication. Recapture uses the existing bounded context-drift retries and closes each prior owner before retrying; pinned contexts, unclassified failures and cleanup failures remain blocking.
