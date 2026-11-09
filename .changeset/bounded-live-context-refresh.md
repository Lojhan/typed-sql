---
"@typed-sql/analysis": patch
"@typed-sql/cli": patch
---

Refresh automatically observed contexts after confirmed drift in finite live checks and generation,
with at most three attempts sharing the existing batch deadline. Wait for owned cleanup between
attempts, preserve explicit pins, and honor cancellation through cleanup. Watch status distinguishes
queued edits from waiting for changes.
