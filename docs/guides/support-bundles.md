---
title: Create a redacted support bundle
pageType: how-to
description: Preview and write structured typed-sql debugging evidence without exposing SQL, values, identifiers, credentials, or paths by default.
---

# Create a redacted support bundle

typed-sql debug evidence is opt-in. Normal compilation and execution do not emit a support bundle or
require telemetry.

First inspect the inventory without writing a file:

```sh
pnpm exec typed-sql doctor --config typed-sql.config.ts --support-bundle-preview
```

The preview reports the number and kinds of events included. It does not print SQL source or bound
values. After reviewing that inventory, explicitly confirm a destination:

```sh
pnpm exec typed-sql doctor \
  --config typed-sql.config.ts \
  --support-bundle .typed-sql/support.json \
  --confirm-support-bundle
```

Default redaction removes SQL and TypeScript source, bound values, parameters, database identifiers,
credentials, connection strings, paths, URIs, and arbitrary free-form error text. Stable failure codes,
classifications, phase names, durations, cache counters, capability decisions, and version evidence remain.
Driver and server error messages are debug context, not a typed-sql compatibility contract.

Inspect the generated JSON before sharing it. The bundle is application metadata and may still reveal
installed versions, enabled capabilities, event timing, and failure classifications.

Library integrations can use `createDebugEvent`, `createSupportBundle`, and `serializeSupportBundle`
from `@typed-sql/core`. Options that retain SQL, identifiers, paths, or free-form text require explicit
opt-in and should only be used inside a controlled diagnostic boundary.
