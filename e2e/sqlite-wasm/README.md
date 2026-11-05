# SQLite Wasm browser verification

Run `pnpm e2e:sqlite-wasm` from the repository root. The suite installs Chromium,
builds a consumer from packed packages, and verifies OPFS and SAH-pool in dedicated
workers. Evidence is written under `artifacts/sqlite-wasm/browser`.

See the canonical [SQLite Wasm persistence guide](../../docs/guides/sqlite-wasm.md).
