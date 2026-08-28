# @typed-sql/schema

Stable, versioned database snapshots, deterministic generation, migrations, hashes, and drift
detection for [typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/schema
```

```ts
import {
  SCHEMA_FORMAT_VERSION,
  calculateSchemaHash,
  checkSchemaDrift,
  loadSchemaSnapshot,
  migrateSchemaSnapshot,
  parseSchemaSnapshot,
} from "@typed-sql/schema";
```

Snapshots record the dialect contract, server catalog, TypeScript mappings, supported-function
volatility evidence, and deterministic hash.
Unknown future formats fail explicitly. Generated TypeScript is inspection metadata, not an
application-facing `sql` or runtime-policy module.

Applications normally use this package through `@typed-sql/cli`; grammar and tooling authors use
it to validate snapshots and implement providers. Read
[Schema snapshots](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/schema-snapshots.md) and
[Architecture](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/architecture.md).

MIT © typed-sql contributors
