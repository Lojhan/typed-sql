---
title: Bun
description: Compile SQL modules and inline queries with Bun.build, runtime preloads, and bun test.
pageType: tutorial
---

# Bun

Complete the [shared setup](./index.md). Install the adapter as a development dependency when
bundling, or as an application dependency when the deployed runtime uses the preload:

```sh
bun add -d @typed-sql/build @types/bun
```

Include `"bun"` in `compilerOptions.types` when checking build scripts or application modules
that use Bun globals. Keep your existing Node types if the project uses them too.

The Bun adapter uses Bun's native plugin API and configuration bundler. It does not register
Node's TypeScript loader. SQL analysis reads the saved snapshot without calling its provider.

## Build

```ts
// build.ts
import { typedSql } from "@typed-sql/build/bun";

const queries = await typedSql();
const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "bun",
  sourcemap: "external",
  plugins: [queries],
});

if (!result.success) throw new AggregateError(result.logs, "Build failed");
```

```sh
bun run build.ts
```

Await `typedSql()` before starting `Bun.build`. Configuration loading must complete before Bun
starts parsing the application's modules. The adapter compiles `.sql` files and inline queries
in TypeScript; Bun performs normal TypeScript transpilation.

Each plugin instance captures its configuration and snapshot when created. Create a new instance
for a fresh build after changing those inputs. Runtime and test watch processes should restart
after configuration or schema changes. The plugin does not promise live reload of files that
Bun's own watcher does not observe.

## Run without bundling

```sh
bun --preload @typed-sql/build/bun-register src/main.ts
```

Start from the application directory, or set `TYPED_SQL_BUILD_CWD` and optionally
`TYPED_SQL_BUILD_CONFIG`. Deploy the original SQL assets, configuration and its local imports,
snapshot, selected grammar, and runtime driver. SQL file imports and inline query modules are
compiled as they load.

## Test

```sh
bun test --preload @typed-sql/build/bun-register
```

For a persistent configuration:

```toml
# bunfig.toml
[test]
preload = ["@typed-sql/build/bun-register"]
```

```ts
import { expect, test } from "bun:test";
import findUser from "./find-user.sql";
import { database } from "./database.ts";

test("finds a user", async () => {
  expect(await database.all(findUser("ada@example.com"))).toHaveLength(1);
});
```

Use a Bun-compatible explicit driver or adapter for the application's database. The integration
does not substitute `node:sqlite` for `bun:sqlite` or select a database driver for you.

## Checking and compatibility

Generate SQL declarations and run `typed-sql check` separately; Bun transpilation does not
typecheck application results. Follow the [shared typechecking workflow](./index.md).

Packed-consumer tests exercise Bun 1.4.4 for builds, runtime imports, and `bun test`, including
real `bun:sqlite` execution and invalid-SQL rejection. Configuration loading requires Bun's
`Bun.build` metafile support.
