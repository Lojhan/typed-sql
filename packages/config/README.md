# @typed-sql/config

Grammar-neutral configuration discovery and executable TypeScript config loading for
[typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/config@next
```

```ts
import { discoverConfig, fromConfig, loadConfig } from "@typed-sql/config";

const file = await discoverConfig(process.cwd());
const loaded = await loadConfig({ file });
const schemaFile = fromConfig(loaded.directory, loaded.config.schema.file);
```

Discovery walks upward for:

- `typed-sql.config.ts`
- `typed-sql.config.mts`
- `typed-sql.config.mjs`
- `typed-sql.config.js`

Loaded configs must default-export a valid dialect contract. The CLI and language server use this
package so neither tool needs a built-in PostgreSQL or MySQL dependency.

Config modules are executable application build code and have the same authority as other local
scripts. Do not load configs from untrusted repositories outside an appropriate sandbox.

MIT © typed-sql contributors
