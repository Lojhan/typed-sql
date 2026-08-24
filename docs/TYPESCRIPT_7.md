# Why TypeScript 7 matters

typed-sql was not literally impossible before TypeScript 7. A TypeScript 5/6 implementation could
have generated declaration files, transformed files before checking, or shipped a `tsserver`
plugin. Each route compromises part of the product contract:

| Earlier route | What it could do | What it could not guarantee cleanly |
| --- | --- | --- |
| generated `.ts`/`.d.ts` API | give named queries exact types | keep application imports on the dialect package with no generated query wrappers |
| build-only source transform | prove exact types in CI | make the unchanged editor program see the same types |
| `tsserver` plugin | alter JavaScript TypeScript language-service behavior | work consistently across LSP editors or survive the native-server transition |
| custom SQL language server | show an inferred SQL hover | make downstream TypeScript expressions such as `rows` acquire the real type |

The hard part was never turning a SQL result into the text `{ id: bigint }`. It was making that type
part of the same semantic TypeScript program that checks the developer's unchanged file.

## What 7.0 changed

TypeScript 7.0 is the native Go port of the compiler and language service. It introduces native
parallelism, ships the editor service through LSP, and usually makes full builds substantially
faster. This gives typed-sql a fast, editor-neutral foundation and one native checker model for CLI
and editor integration.

It also removed an old escape hatch: TypeScript 7.0 intentionally ships without a programmatic API
or `tsserver.js`. Tools that import the compiler must temporarily use TypeScript 6 compatibility or
wait for the new API. TypeScript 7.0 alone therefore did not unlock typed-sql's semantic bridge; in
one important sense it made the old plugin approach unavailable.

See the TypeScript team's [7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
and [native-port design announcement](https://devblogs.microsoft.com/typescript/typescript-native-port/).

## What the 7.1 preview changed

The pinned TypeScript `7.1.0-dev.20260824.1` preview publishes a new, explicitly unstable API under
`typescript/unstable/async` and `typescript/unstable/ast`. The pieces typed-sql relies on are:

- `API.updateSnapshot()` to load the real project graph;
- `API.runWithTemporaryFileUpdate()` to replace source text only inside a disposable snapshot;
- `Project.program` and `Project.checker` to inspect the actual semantic program;
- `Checker.getTypeAtLocation()` and `typeToString()` to verify the propagated query type;
- `API.fromLSPConnection()` plus the native server's `custom/initializeAPISession` transport for
  sharing an editor session when the host exposes it.

That temporary update is the bridge. typed-sql first analyzes a static template against the schema
snapshot, then overlays the equivalent generic in memory:

```ts
// developer source
const query = sql`SELECT account.id FROM account`;

// temporary semantic snapshot; never written to disk
const query = sql<{ id: bigint }>`SELECT account.id FROM account`;
```

TypeScript now performs the ordinary generic propagation itself. `query` becomes
`Query<{ id: bigint }>` and `await database.execute(query)` becomes
`readonly { id: bigint }[]`. typed-sql maps positions back to the original source before returning
hover and diagnostic results.

The API-session hook is visible in the native extension's
[`initializeAPIConnection`](https://github.com/microsoft/typescript-go/blob/main/_extension/src/extension.ts)
and its client's
[`custom/initializeAPISession`](https://github.com/microsoft/typescript-go/blob/main/_extension/src/client.ts)
request. The standalone bridge can also spawn its own preview API process, which is the path used by
tests and hosts that do not expose a shared session.

## Why the architecture is safe to publish

The new API is still preview software. typed-sql treats it as an adapter, not as a public
foundation:

1. `@typed-sql/core`, the dialect contract, schema snapshots, and runtime query values contain no
   TypeScript preview types.
2. `@typed-sql/compiler` produces deterministic transformed source and remains the authoritative
   CLI/CI correctness path on stable TypeScript 7.0.2.
3. `@typed-sql/ts-bridge` alone pins the exact 7.1 preview and communicates across a replaceable
   process boundary.
4. Unknown or unavailable semantics fall back safely to a diagnostic or `Query<unknown>`, never an
   invented application type.
5. When TypeScript 7.1 publishes its stable API, only the bridge adapter should need to change.

So the new TypeScript architecture did not make SQL inference possible. It made the desired product
shape feasible: unchanged SQL authoring, a single dialect-package import, editor-neutral LSP, and
exact types that genuinely propagate through the TypeScript program.
