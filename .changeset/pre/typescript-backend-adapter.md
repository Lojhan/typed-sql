---
"@typed-sql/ts-bridge": minor
"@typed-sql/language-server": patch
---

Add an explicit TypeScript backend contract with immutable backend identities, opaque project
handles, overlay inspection, deterministic project disposal, and an exact TypeScript 7.1 adapter.
Contain all unstable TypeScript API imports inside the version-specific adapter while retaining the
native preview bridge as a compatibility wrapper.
