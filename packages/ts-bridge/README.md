# @typed-sql/ts-bridge

> **Experimental:** this package depends on a pinned TypeScript 7.1 preview API and remains on the
> npm `next` track when the SQL/compiler packages reach stable 1.0.

The TypeScript 7 semantic bridge behind typed-sql editor inference.

```sh
pnpm add @typed-sql/ts-bridge@next
```

```ts
import { analyzeSource, queryAtPosition } from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";

const analysis = analyzeSource(source, schema, dialect, typePolicy);
const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: projectDirectory });

try {
  const inspections = await bridge.inspectFile({
    fileName: sourceFile,
    projectFile: tsconfigFile,
    analysis,
  });
} finally {
  await bridge.close();
}
```

The bridge inserts `Query<Row, Parameters>` types into an in-memory source overlay, delegates the complete
semantic program to a pinned TypeScript 7.1 preview process, and maps positions back to the unchanged
file. The process boundary deliberately contains preview API churn; the grammar and query contract
do not depend on unstable TypeScript internals.

Subpaths:

- `@typed-sql/ts-bridge` — analysis, query bindings, and source mapping;
- `@typed-sql/ts-bridge/native-preview` — isolated preview process client;
- `@typed-sql/ts-bridge/native-lsp` — native LSP connection adapter.

Application projects normally receive this package through `@typed-sql/language-server`.

MIT © typed-sql contributors
