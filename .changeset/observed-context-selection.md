---
"@typed-sql/analysis": minor
"@typed-sql/config": minor
"@typed-sql/cli": minor
---

Support live context discovery and refresh without a pre-recorded context file. Bind recorded
selection to the configured target, schema, installed profile and decoding policy; fence competing
observations and retire prior query evidence when the selected epoch changes. Explicit context pins
retain their behavior.

Include target/context selection in durable manifests for offline and frozen consumption. Frozen
checks ignore disposable observations; hybrid offline rules remain available without claiming a
native observation. Revalidate context/query cache snapshots before publishing generated inputs.

Dispose constructed native services if subsequent configuration dependency tracking fails.
