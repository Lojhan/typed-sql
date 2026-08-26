# @typed-sql/config

Stable, grammar-neutral configuration discovery and executable TypeScript config loading for
[typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/config
```

```ts
import { discoverConfig, fromConfig, loadConfig } from "@typed-sql/config";

const file = await discoverConfig(process.cwd());
const loaded = await loadConfig({ file });
const schemaFile = fromConfig(loaded.directory, loaded.config.schema.file);
```

Discovery walks upward for `typed-sql.config.ts`, `.mts`, `.mjs`, or `.js`. Loaded configs must
default-export a valid dialect contract. Config modules are executable application build code; do
not load them from untrusted repositories outside an appropriate sandbox.

Read the [configuration guide](https://github.com/Lojhan/typed-sql/blob/main/docs/getting-started/configuration.md).

MIT © typed-sql contributors
