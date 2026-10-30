---
title: Bundler adapters
description: Configure webpack, Rspack, Rsbuild, esbuild, Rollup, and Rolldown to compile SQL files and inline query plans.
pageType: tutorial
---

# Bundler adapters

Complete the [shared setup](./index.md) before configuring a host. The following adapters compile
SQL modules and inline TypeScript queries. They leave application-owned database drivers and
the choice of deployment target to your bundler configuration.

Keep your existing entrypoints, output format, framework plugins, and external dependencies.
These snippets show where to add typed-sql to those configurations.

## webpack

```sh
pnpm add -D @typed-sql/build webpack webpack-cli esbuild
```

```js
// webpack.config.mjs
import { typedSql } from "@typed-sql/build/webpack";

export default {
  target: "node",
  plugins: [typedSql()],
};
```

The plugin adds a pre-loader for SQL and TypeScript files. The loader compiles SQL and uses
your application's esbuild to transpile changed TypeScript. Existing framework loaders continue
to handle their other transforms. If your following loader must receive TypeScript, use
`typedSql({ transpile: false })` and let that loader transpile it.

To compose a rule yourself, the loader path is `@typed-sql/build/webpack-loader`. webpack applies
loaders from right to left; typed-sql must receive the original TypeScript before transpilation.

```sh
pnpm exec webpack
```

## Rspack

```sh
pnpm add -D @typed-sql/build @rspack/core @rspack/cli esbuild
```

```js
// rspack.config.mjs
import { typedSql } from "@typed-sql/build/rspack";

export default {
  target: "node",
  plugins: [typedSql()],
};
```

```sh
pnpm exec rspack build
```

The Rspack adapter uses the same loader and options as webpack.

## Rsbuild

```sh
pnpm add -D @typed-sql/build @rsbuild/core esbuild
```

```ts
// rsbuild.config.ts
import { defineConfig } from "@rsbuild/core";
import { typedSql } from "@typed-sql/build/rsbuild";

export default defineConfig({
  plugins: [typedSql()],
});
```

```sh
pnpm exec rsbuild build
```

The plugin installs the Rspack adapter through Rsbuild's configuration hook.

## esbuild

```sh
pnpm add -D @typed-sql/build esbuild
```

```js
// build.mjs
import { build } from "esbuild";
import { typedSql } from "@typed-sql/build/esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/main.js",
  plugins: [typedSql()],
});
```

```sh
node build.mjs
```

Use esbuild's build or context API; the standalone `transform` API does not execute plugins.
The adapter registers SQL sources, configuration imports, and the snapshot as watch inputs.
If another on-load plugin matches the same files, arrange for typed-sql to receive their original
SQL or TypeScript source: esbuild stops after the first plugin returns contents.

## Rollup

```sh
pnpm add -D @typed-sql/build rollup esbuild
```

```js
// rollup.config.mjs
import { typedSql } from "@typed-sql/build/rollup";

export default {
  input: "src/main.ts",
  output: { file: "dist/main.js", format: "esm", sourcemap: true },
  plugins: [typedSql()],
};
```

```sh
pnpm exec rollup --config
```

Rollup does not parse TypeScript itself. This adapter uses your application's esbuild to strip
TypeScript after SQL compilation. Configure package resolution or externalization as usual;
the adapter does not bundle database drivers implicitly. JSX remains available to your JSX plugin.

## Rolldown

```sh
pnpm add -D @typed-sql/build rolldown
```

```js
// rolldown.config.mjs
import { typedSql } from "@typed-sql/build/rolldown";

export default {
  input: "src/main.ts",
  output: { file: "dist/main.js", format: "esm", sourcemap: true },
  plugins: [typedSql()],
};
```

```sh
pnpm exec rolldown --config
```

Rolldown handles TypeScript transpilation. The adapter supplies SQL compilation and source maps.

## Checking and watch mode

Run declaration generation and the typed-sql checker before a production build:

```sh
pnpm exec typed-sql-build types
pnpm exec typed-sql check
```

Bundler transforms validate SQL but do not replace downstream TypeScript checking. The adapters
register the saved snapshot and configuration dependencies with hosts that expose watch APIs.

## Compatibility

| Host | Supported range | Exact packed-consumer version |
| --- | --- | --- |
| webpack | `>=5 <6` | 5.112.2 |
| Rspack | `>=2 <3` | 2.3.0 |
| Rsbuild | `>=2 <3` | 2.3.0 |
| esbuild | `>=0.28 <0.29` | 0.28.2 |
| Rollup | `>=4 <5` | 4.66.0 |
| Rolldown | `>=1 <2` | 1.2.16 |

The real-host tests execute SQL-file and inline queries against an isolated SQLite database
and verify that invalid SQL fails each host build. Host engine requirements apply in addition
to `@typed-sql/build`'s Node.js minimum.
