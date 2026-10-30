---
title: Node and test runner preloads
description: Run SQL file imports on Node.js and use them from the native test runner, Mocha, AVA, and Poku.
pageType: tutorial
---

# Node and test runner preloads

The Node preload compiles `.sql` imports as they load. It requires an ESM application and
Node.js 24.11.1 or newer; Node.js 25 requires 25.1.0 or newer. Use the Node version required by
your test runner if that requirement is higher.

Complete the [shared setup and declaration generation](./index.md), then install the package
as a runtime dependency if production starts Node with the preload:

```sh
pnpm add @typed-sql/build
node --import=@typed-sql/build/register src/main.ts
```

Node's normal restrictions on TypeScript type stripping apply. For direct `.ts` imports,
set `allowImportingTsExtensions: true` with `noEmit: true` in the TypeScript project.
The examples use an application-owned `database.ts` module exporting the test connection. The preload compiles SQL files;
it does not transform inline TypeScript templates. Use a build adapter when you need compiled
inline execution plans.

Start from the application directory containing the typed-sql configuration. Alternatively set
`TYPED_SQL_BUILD_CWD` and, if needed, `TYPED_SQL_BUILD_CONFIG`. The preload reads one saved snapshot
at startup. Restart the process after changing the schema, type policy, or configuration.

Deploy the configuration, its local dependencies, snapshot, grammar, and original SQL files.
If emitted `dist/main.js` imports `./find-user.sql`, copy that SQL file to `dist/find-user.sql`.
A bundled deployment can compile the assets ahead of time instead.

## Native Node test runner

```sh
node --import=@typed-sql/build/register --test
```

Tests import SQL files directly:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import findUser from "./find-user.sql";
import { database } from "./database.ts";

test("finds a user", async () => {
  assert.equal((await database.all(findUser("ada@example.com"))).length, 1);
});
```

The examples below use the same SQL imports and an application-owned test database.

## Mocha

```sh
pnpm add -D @typed-sql/build mocha
pnpm exec mocha --node-option import=@typed-sql/build/register 'test/**/*.test.mjs'
```

Mocha forwards `--node-option` to its Node subprocess. The preload runs before Mocha loads tests.

## AVA

```sh
pnpm add -D @typed-sql/build ava
```

```js
// ava.config.mjs
export default {
  files: ["test/**/*.test.mjs"],
  nodeArguments: ["--import=@typed-sql/build/register"],
};
```

```sh
pnpm exec ava
```

AVA's worker processes receive the preload through `nodeArguments`.

## Poku

```sh
pnpm add -D @typed-sql/build poku
NODE_OPTIONS='--import=@typed-sql/build/register' pnpm exec poku test --enforce
```

`NODE_OPTIONS` passes the preload to Poku's isolated Node test processes. Scope this environment
variable to the test command. Add `tsx` if the chosen Poku workflow needs it for TypeScript tests.

## Tested versions

Packed-consumer tests run the native Node test runner, Mocha 12.0.3, AVA 8.2.0, and Poku 4.5.0.
AVA 8.2.0 requires Node.js `^22.20.0 || ^24.12.0 || >=26`; the preload's own minimum also applies.
