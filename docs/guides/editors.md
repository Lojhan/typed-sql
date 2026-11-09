---
title: Editor setup
pageType: how-to
description: Configure the experimental typed-sql language server for Zed, VS Code, or another LSP client.
---

# Editor setup

The experimental language server applies typed-sql's inferred overlay before TypeScript checks the program. It provides exact query and downstream hovers, diagnostics, completion, definitions, quick fixes, schema reloads, stale-result suppression, and bounded project caches. PostgreSQL, MySQL, and SQLite use the same protocol and compiler evidence.

Editor discovery and inference come from the same versioned, serializable source-analysis service as
`typed-sql check`. Results carry source, grammar/capability, schema, type-policy, compiler-option, and
revision identities; a resource limit or cancellation never publishes a partial inferred contract.

Install it in the application:

```sh
pnpm add -D @typed-sql/language-server
```

The package starts Microsoft's pinned TypeScript preview language server and forwards ordinary
TypeScript requests to it. typed-sql adds inferred SQL types and projects results back onto your
original source. It does not reimplement TypeScript's language service or load the workspace's
`tsserver.js`.

If startup reports a TypeScript compatibility error, run `pnpm exec typed-sql doctor` in the
workspace. The bridge refuses an overridden or mismatched preview patch before project loading.

## Recorded query contracts

The language server reads the project's `analysis` configuration. In `"frozen"` mode it uses only
[declared durable query contracts](../getting-started/configuration.md#checking-durable-query-contracts);
missing or incompatible evidence remains a diagnostic. It does not open the disposable cache or
initialize an analyzer, schema provider, or native adapter.

In `"offline"` mode it reuses compatible durable or cached contracts. Hybrid qualification loads
the configured offline analyzer for uncovered queries; native-required qualification leaves those
queries unknown. Templates and raw SQL documents use the same prepared contract view. Contract
manifest and cache-index changes participate in editor invalidation, and each request validates its
recorded inputs before publishing types.

Query hovers show the evidence origin and recorded context digest. Matching recorded evidence is
labelled with unverified remote freshness; TypeScript preview verification does not establish
current database validity. Offline analysis without a query contract is identified separately.

In `"live"` mode, an explicit `analysis.live.adapter` registration enables native acquisition.
The project shares one owned adapter and bounded query scheduler. Context checks are coalesced
across requests, with a five-second default interval; `analysis.live.contextIntervalMs` adjusts it.
Native descriptions retain their own consistency checks. SQL edits and project/context changes
fence old views, and the proxy refreshes its TypeScript overlay before forwarding requests.

While native qualification is pending, open queries can show informational `TSQ409` diagnostics
at their source ranges. Short operations finish before that message appears. The diagnostic
does not certify the query or expose a previous incompatible type. Completion clears it and
refreshes the current types and ordinary diagnostics. A follow-up diagnostic pull consumes the
completed view rather than starting another qualification cycle.

Connection failures preserve matching recorded evidence with unverified remote freshness. Native
rejections, conflicts and known context changes remain blocking. Hybrid analysis can use independent
offline rules when the native adapter does not support a statement class; that does not establish
native qualification. The `typedSql/status` response includes connection state and the last context
observation time. There is no idle database polling: external database changes are detected on a
subsequent editor request. Closing or reconfiguring the project closes its owned native resources.

SQL-file content mappers and other build hosts have separate configuration support. Live editor
support does not imply native qualification for every grammar, transport or SQL statement class.

## Zed

Install the native extension from the repository's [`editors/zed`](https://github.com/Lojhan/typed-sql/tree/main/editors/zed) directory as a development extension. The following opt-in configuration selects the proxy as the active TypeScript server; its upstream process supplies ordinary TypeScript language features:

```json
{
  "languages": {
    "TypeScript": {
      "language_servers": ["typed-sql", "!vtsls", "!typescript-language-server"]
    },
    "TSX": {
      "language_servers": ["typed-sql", "!vtsls", "!typescript-language-server"]
    }
  },
  "lsp": {
    "typed-sql": {
      "settings": {
        "configPath": "typed-sql.config.ts",
        "projectFile": "tsconfig.json",
        "nativePreview": true
      }
    }
  }
}
```

Do not run `vtsls` or `typescript-language-server` beside this proxy. An ordinary TypeScript server sees the safe declaration baseline `Query<unknown>` and can display a competing hover.

`schemaPath` is optional. When omitted, the server uses `schema.file` from the discovered config.

## VS Code

Install [typed-sql from Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=lojhan.typed-sql)
and Microsoft's [TypeScript 7 extension](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview).
The typed-sql extension uses each workspace folder's installed language server. A repository checkout
or local VSIX build is not required.

After the CLI quickstart works, configure the application:

```sh
pnpm exec typed-sql init --grammar postgres --editor vscode --apply --verify
```

Choose `mysql` or `sqlite` for those grammars. This preserves the existing database config, writes
workspace settings and recommendations, and checks the installed server. Run `typed-sql check` to
check the project itself; server startup and editor-host readiness are distinct.

The preferred VS Code mode uses Microsoft's [TypeScript 7 extension](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview) as the language client. Its custom SDK launches the installed typed-sql proxy. Microsoft's built-in TypeScript extension stays enabled and coordinates provider ownership with the native client.

Select the SDK directory for the machine running the workspace extension host:

| Host | SDK directory inside `@typed-sql/language-server` |
| --- | --- |
| macOS arm64 / x64 | `sdk/darwin-arm64` / `sdk/darwin-x64` |
| Linux arm64 / x64 | `sdk/linux-arm64` / `sdk/linux-x64` |
| Windows arm64 / x64 | `sdk/win32-arm64` / `sdk/win32-x64` |

For example, a macOS arm64 workspace uses:

```json
{
  "js/ts.experimental.useTsgo": true,
  "js/ts.tsdk.path": "./node_modules/@typed-sql/language-server/sdk/darwin-arm64",
  "typedSql.providerMode": "native-sdk"
}
```

Use **TypeScript: Select TypeScript Version** to approve the workspace SDK when prompted. The extension host needs Node.js 22.11 or newer on `PATH`; `TYPED_SQL_NODE` can select a specific Node executable. The SDK is an editor launcher; application compiler checks continue to use `typed-sql check` and the supported stable compiler.

The standalone `proxy` mode remains available when the built-in TypeScript provider is explicitly disabled for the workspace. In `auto` mode, typed-sql refuses to start competing providers and reports the required setup in its output channel. It does not disable other extensions or change TypeScript preferences during activation.

Run **typed-sql: Show TypeScript Bridge Status** to inspect provider ownership and the selected SDK.
Standalone clients also report their pinned TypeScript version and open/indexed document counts.
In native SDK mode, use Microsoft's **TypeScript 7** output channel for live server logs.

The extension requires a trusted workspace because it executes the workspace-installed server and
project configuration. It stays disabled in Restricted Mode and does not support virtual workspaces
whose files are exposed through non-filesystem providers. This is distinct from running in a remote
workspace extension host with filesystem access.

## Other LSP clients

Start the installed server over standard input/output:

```sh
pnpm exec typed-sql-language-server --stdio
```

Initialization settings accept:

```json
{
  "configPath": "typed-sql.config.ts",
  "schemaPath": "src/generated/db/schema.json",
  "projectFile": "tsconfig.json",
  "nativePreview": true,
  "maxCacheEntries": 256,
  "maxWorkspaceFiles": 2000,
  "analysisDebounceMs": 20,
  "protocolVersion": 1,
  "protocolCapabilities": ["analysis-identity", "diagnostic-fixes", "status"]
}
```

Relative paths resolve from the LSP workspace root. Each workspace folder receives its own config, grammar, schema, TypeScript project, and bounded cache.

The custom `typedSql/status` request returns the server mode, exact pinned TypeScript version,
workspace roots, document counts, and negotiated protocol. It is informational; CLI/compiler output
remains the correctness boundary.

The current typed-sql-specific request and initialization shape is protocol v1. The server returns
the negotiated capability intersection in `initialize.typedSql.protocol`. Existing clients without
an explicit protocol version retain every v1 capability. Unsupported versions fail before workspace
analysis begins. Diagnostics are published only while their source, project/config generation,
grammar capabilities, schema, and type-policy identities remain current.

The server actively cancels superseded edit analysis, applies incremental changes to a separate
current document snapshot, and serializes configuration/schema refreshes. If config, grammar, or
schema loading fails, it replaces prior positive output with a redacted
`TYPED_SQL_PROJECT_UNAVAILABLE` diagnostic. Correct the input and trigger a file refresh to retry
without restarting the editor. `typedSql/status` includes cache hit/miss/eviction counters and
native-bridge restart counts for troubleshooting.

## Supported editor features

typed-sql adds query and downstream TypeScript hovers, SQL diagnostics, schema-aware table and
column completion, definition links into the generated schema, and quick fixes attached to
typed-sql diagnostics. Ordinary TypeScript features are delegated to the upstream language server,
not limited to schema objects. Protocol tests compare ordinary definitions, same- and cross-file
references and rename, member completion resolution, and formatting edits with the upstream server.
Semantic highlighting is projected onto original source positions, including full, range and delta
responses. Versioned edits and resolve requests reject stale source snapshots.

These checks are narrower than full editor compatibility. General refactors, generated-text edits,
and editor-specific JavaScript/TypeScript commands do not have a blanket parity guarantee. Keep the
integration opt-in and use `typed-sql check` as the authoritative inference check.

The VS Code extension surfaces `typedSql/status` through its status command. The Zed extension is a
launcher and settings adapter; use another LSP-capable client or protocol tooling when direct
custom-request UI is needed.

The compiler/editor matrix runs on Node 22 from 22.11, current Node 22, Node 24, and Node 26. It uses
the exact compiler and preview patches listed in [Compatibility](../reference/compatibility.md).
Package exports are ESM; CommonJS application entrypoints can consume them only through Node's
supported ESM interoperation rather than a separate CommonJS build.

The language server reads the local snapshot and does not need a database connection during normal
editing. Generate or refresh the snapshot with `typed-sql generate`; a watched snapshot replacement
invalidates dependent results. If the snapshot is temporarily missing or invalid, the server clears
prior positive analysis and reports `TYPED_SQL_PROJECT_UNAVAILABLE` until a later file refresh
succeeds.
