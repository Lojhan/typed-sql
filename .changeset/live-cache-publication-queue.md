---
"@typed-sql/analysis": patch
---

Serialize publication-lock acquisition across cache handles within one process so concurrent live checks do not exhaust the filesystem lock's retries competing with their own writers. Cross-process locking, publication fencing and existing retry limits remain enforced.
