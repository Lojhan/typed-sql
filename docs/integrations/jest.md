---
title: Jest
description: Compile typed-sql queries in Jest ESM and CommonJS tests while retaining an existing Babel or SWC transformer.
pageType: tutorial
---

# Jest

Complete the [shared configuration and declaration setup](./index.md), then install:

```sh
pnpm add -D @typed-sql/build jest esbuild
```

The transformer compiles `.sql` files and inline queries. It uses your application's `esbuild`
to transpile TypeScript when no existing transformer is configured. It does not typecheck tests;
run `typed-sql check` separately.

## ESM tests

```js
// jest.config.mjs
export default {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts", ".tsx", ".sql"],
  transform: {
    "\\.(?:sql|[cm]?tsx?)$": ["@typed-sql/build/jest", {}],
  },
  dependencyExtractor: "@typed-sql/build/jest-dependencies",
};
```

Include `.sql` in `extensionsToTreatAsEsm` so Jest requests an ESM transform for SQL imports.
Enable Jest's VM-module execution:

```sh
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest
```

```ts
import { expect, test } from "@jest/globals";
import findUser from "./find-user.sql";
import { database } from "./database.ts";

test("finds a user", async () => {
  expect(await database.all(findUser("ada@example.com"))).toHaveLength(1);
});
```

Create and clean up your test database through your normal test fixtures. Build transforms
read the saved snapshot without introspecting that database.

## CommonJS tests

Omit `extensionsToTreatAsEsm` to request CommonJS transforms. The library packages are ESM;
Jest's `require(esm)` support requires a sufficiently recent Node.js version. The packed-consumer
CommonJS suite uses Jest 30.5.2 and Node.js 24.22.2. Node.js 24.9 or newer is required for this
Jest interoperability path; use the higher minimum required by your other tools.

## Retain an existing transformer

Jest selects one matching transformer per file. Listing typed-sql and Babel as two matching
`transform` entries does not compose them. Instead, delegate from typed-sql:

```sh
pnpm add -D babel-jest @babel/preset-env @babel/preset-typescript
```

```js
// jest.config.mjs
export default {
  testEnvironment: "node",
  transform: {
    "\\.(?:sql|[cm]?tsx?)$": [
      "@typed-sql/build/jest",
      {
        transformer: {
          module: "babel-jest",
          options: {
            presets: [
              ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
              ["@babel/preset-typescript", { allExtensions: true }],
            ],
          },
        },
      },
    ],
  },
  dependencyExtractor: "@typed-sql/build/jest-dependencies",
};
```

The shared compiler runs before the delegated transformer. Babel retains mock hoisting and
instrumentation behavior, and source maps are composed. SQL modules bypass Babel and use the
internal JavaScript output plus the application's esbuild transpiler. An alternative transformer
must return Jest's `{ code, map? }` result; CommonJS callers require its synchronous `process`
method. Keep the delegate's own configuration and dependencies installed in the application.

## Cache and watch inputs

Transform cache keys include the snapshot, executable configuration and local imports, source,
module format, instrumentation setting, esbuild version when used, and delegated transformer cache key. The dependency
extractor adds configuration and schema files to Jest's dependency graph so watch mode can
associate those changes with SQL consumers.

For a non-default project directory or configuration, give the transform `cwd` and `config`.
Use a matching dependency extractor configuration:

```js
// jest-sql-dependencies.cjs
const { createDependencyExtractor } = require("@typed-sql/build/jest-dependencies");
module.exports = createDependencyExtractor({ cwd: __dirname, config: "typed-sql.config.mjs" });
```

Set Jest's `dependencyExtractor` to the absolute path of this file. Alternatively, the default
extractor reads `TYPED_SQL_BUILD_CWD` and `TYPED_SQL_BUILD_CONFIG`.

## Compatibility

The supported Jest range is `>=30.5 <31`. Packed-consumer tests exercise Jest 30.5.2 in ESM,
CommonJS, and delegated Babel modes, including mock hoisting, coverage, and persistent cache
invalidation when an imported configuration module changes.
