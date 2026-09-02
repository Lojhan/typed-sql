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

`analyzeSource()` delegates discovery, inference, source mapping, identities, and resource limits to
the authoritative serializable analysis service in `@typed-sql/compiler`. The bridge owns only the
preview TypeScript backend and compatibility wrapper.

`createTypeScriptBackend()` returns the adapter recorded by `TYPESCRIPT_BACKEND_ADAPTERS`. The
backend exposes an immutable identity, opaque project handles, overlay inspection, explicit project
disposal, and process disposal without returning TypeScript nodes or symbols. The current exact
adapter is `typescript-7.1-native-preview`; every `unstable/*` import is contained in its
version-specific module. `NativePreviewTypeScriptBridge` remains the simpler compatibility API.

Backend creation validates the installed preview package against the exact supported patch before
loading a project. Dependency overrides fail with `TypeScriptPreviewCompatibilityError` and an
actionable reinstall instruction instead of attempting an unknown unstable API.

`TYPESCRIPT_SUPPORT_POLICY` records the exact tested boundary: compiler correctness uses TypeScript
7.0.2 and the editor backend uses `7.1.0-dev.20260824.1`. Another patch or major/minor line is not
silently accepted as equivalent. New lines enter the matrix as non-blocking canaries before support.

Public subpaths are `/native-preview` for the preview client and `/native-lsp` for the native LSP
connection adapter. Applications normally receive this package through
`@typed-sql/language-server`.

Read [Editor setup](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md) and
[Compatibility](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/compatibility.md).

MIT © typed-sql contributors
