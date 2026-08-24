# @typed-sql/schema

Versioned database snapshots, deterministic generation, migrations, hashes, and drift detection for
[typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/schema@next
```

```ts
import {
  SCHEMA_FORMAT_VERSION,
  calculateSchemaHash,
  checkSchemaDrift,
  generateSchemaPackage,
  loadSchemaSnapshot,
  migrateSchemaSnapshot,
  parseSchemaSnapshot,
} from "@typed-sql/schema";
```

Schema format `1` records the dialect, dialect version, server version, tables, columns, views,
enums, domains, arrays, database functions, nullability, TypeScript mappings, and deterministic
hashes. Unknown future snapshot versions fail explicitly instead of being interpreted optimistically.

Generated TypeScript is metadata for inspection and editor tooling. Applications do not import
their `sql` tag or runtime policy from the generated directory.

Most applications use this package indirectly through `@typed-sql/cli`. Grammar and tooling authors
use it to validate snapshots and implement providers. See the
[architecture](https://github.com/Lojhan/typed-sql/blob/main/docs/ARCHITECTURE.md).

MIT © typed-sql contributors
