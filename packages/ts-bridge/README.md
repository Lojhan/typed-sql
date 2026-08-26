# @typed-sql/ts-bridge

> Experimental: this package isolates the preview TypeScript API used by typed-sql editor tooling.

```sh
pnpm add @typed-sql/ts-bridge
```

```ts
import { analyzeSource } from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";

const analysis = analyzeSource(source, schema, dialect, typePolicy);
const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: projectDirectory });

try {
  await bridge.inspectFile({ fileName: sourceFile, projectFile: tsconfigFile, analysis });
} finally {
  await bridge.close();
}
```

The bridge creates an in-memory `Query<Row, Parameters>` overlay, delegates the semantic program to
an isolated preview process, and maps positions back to unchanged source. Preview API churn remains
behind that process boundary.

Public subpaths are `/native-preview` for the preview client and `/native-lsp` for the native LSP
connection adapter. Applications normally receive this package through
`@typed-sql/language-server`.

Read [Editor setup](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md) and
[Compatibility](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/compatibility.md).

MIT © typed-sql contributors
