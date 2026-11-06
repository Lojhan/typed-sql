---
title: Local dev workspace
description: Explore your schema, edit project TypeScript and SQL files, inspect inferred contracts, and execute bounded queries through an explicit local target.
pageType: how-to
---

# Local dev workspace

The optional local workspace puts schema relationships, real project files, inferred SQL contracts and query results in one browser window. It runs on loopback, uses your installed grammar and saved schema, and requires no hosted account. The [docs playground](../playground.md) remains an analysis-only example.

## Install and launch

Install the optional host alongside the [CLI and your grammar](../getting-started/index.md):

```sh
pnpm add -D @typed-sql/playground
pnpm exec typed-sql playground --config typed-sql.config.ts --no-open
```

Open the printed local URL. Its session fragment authorizes this browser; keep it local. Without a target, the workspace supports schema exploration, real-file editing and SQL analysis. Connections are lazy: opening the host does not execute project query files or call a target factory.

Use `--project tsconfig.json` to select a project, `--port 5179` to choose a local port, and omit `--no-open` to open the browser automatically. The host requires Node.js 22.11 or newer, matching the CLI's minimum; this repository exercises its connected workflow with Node.js 24.22.2.

## Connect PostgreSQL explicitly

Install the application-owned PostgreSQL drivers:

```sh
pnpm add pg pg-cursor
```

Extend the [existing configuration](../getting-started/configuration.md) with an explicit playground target. Keep the same policy for grammar analysis, introspection and runtime decoding:

```ts
import { defineConfig } from '@typed-sql/core';
import { postgres, typePolicy } from '@typed-sql/postgres';
import { pg } from '@typed-sql/postgres/pg';
import { createPgPlaygroundTarget } from '@typed-sql/playground/pg';

const connectionString = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('Set DATABASE_URL for this target');
  return value;
};

export default defineConfig({
  dialect: postgres({ typePolicy }),
  typePolicy,
  schema: {
    file: 'generated/db/schema.json',
    provider: pg({ connectionString, schemas: ['public'], typePolicy }),
  },
  outDir: 'generated/db',
  projects: ['tsconfig.json'],
  playground: {
    readRoots: ['src', 'playground'],
    writeRoots: ['playground'],
    scratchDirectory: 'playground',
    targets: {
      local: {
        classification: 'development',
        expected: { database: 'app_dev' },
        connect: () => createPgPlaygroundTarget({ connectionString, schemas: ['public'], typePolicy }),
      },
    },
    limits: { timeoutMs: 30_000, maxRows: 500, maxResultBytes: 5 * 1024 * 1024 },
  },
});
```

Generate the initial snapshot before launch:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql playground --target local
```

**Connect database** verifies the observed database identity against the expected name. **Refresh schema** captures the live catalog for exploration and analysis. If it differs from the saved compiler snapshot, execution is blocked until you regenerate the contract and restart. Refresh never silently rewrites application artifacts.

PostgreSQL/pg is the connected adapter. Other grammars can use a saved snapshot for offline exploration; their presence does not imply live execution support. Missing drivers, permissions or connectivity leave saved files and offline schema exploration available.

## Explore and create a query

The board displays captured foreign keys, including composite and cross-schema keys. It never infers relationships from column names. Search relations/columns, focus neighbors, drag cards and reset the layout. Layout positions stay in local browser storage, outside the compiler snapshot. The schema list and inspector provide keyboard-accessible relation/column/constraint information.

Choose a table and **Create query from table**. Preview the path, then create an ordinary `.ts` or `.sql` file under an allowed write root. TypeScript templates include a server-side `db.ts` helper:

```ts
import { databaseForRun } from '@typed-sql/playground/runtime';
export const db = databaseForRun();
```

It returns the selected target's policy-configured managed database for this run and fails outside the host. The query imports `sql` from its grammar, never generated schema files.

Save and Save As write real project files. Revision conflicts are reported rather than silently replacing detected external edits. In-host concurrent writes are serialized. Ordinary filesystems do not provide a portable atomic compare-and-swap against unrelated editors; save conflicts are detected observations, not a hostile-writer guarantee. Symlinks and paths outside configured roots are rejected.

## Execution modes

- **Named export** checks a statically declared zero-argument exported function, evaluates the module, and calls that export once. Its returned value becomes a result.
- **Full file** evaluates top-level code once and captures console output and named results. It does not call exports automatically.
- **SQL statement** compiles one SQL file and binds separately entered scalar parameters. Repeated named/positional references share logical inputs. NULL is explicit. Structured/custom parameter codecs belong in a TypeScript query file.

`Cmd/Ctrl+S` saves; `Cmd/Ctrl+Enter` requests execution. Save, selection, reconnect and schema refresh never execute query files automatically. Run saves the entry and checks its dependency graph with the supported stable TypeScript compiler and typed-sql transforms. Semantic, SQL and build errors block execution. Unsupported SQL remains diagnostic/unknown after a successful live operation.

Each run gets a fresh process and captured local ESM graph with source maps. Static imports, inline SQL and literal `.sql` imports are supported. Dynamic project imports, CommonJS files and `require()` receive an explicit unsupported-graph diagnostic. Installed external dependencies remain trusted and are checked by entry/package identity; this is not a hermetic build of arbitrary package side effects.

For multiple named outputs:

```ts
import { show } from '@typed-sql/playground/runtime';
show('example', [{ id: 42, label: 'A local fixture' }]);
```

## Managed queries and trusted project code

Managed SQL defaults to an actual read-only PostgreSQL transaction. The explicit write toggle enables managed writes. Read-only enforcement belongs to the database; a query's apparent SELECT syntax does not prove it has no side effects. Commands that change transaction/session state are excluded from the single-statement channel.

Enable **trusted project execution** once per session to run TypeScript. Imports execute with your process permissions, including filesystem, environment, network and private database clients. Managed read-only/deadline/cancel controls apply to the supplied helper, not independently created clients. Arbitrary returned TS values are labeled **database target not verified**. Trusted TS execution is disabled for production-classified targets.

The child process has a bounded heap and deadline for lifecycle control; it is not a malicious-code sandbox. User code can intentionally print secrets. Driver/configuration errors use redacted browser messages with detailed failure evidence in the local terminal. Do not expose the listener as a remote service.

## Results, bounds and cancellation

Results retain their source revision, target context, start/end time and terminal status. Raw SQL uses ordered column metadata, preserving duplicate labels and empty-result columns. Typed values distinguish NULL/missing, bigint, date/time, bytes and structured values. Returned object rows cannot reconstruct duplicate labels already collapsed by a private driver.

The grid virtualizes rows and offers cell inspection/copy, fetched-subset filtering/sorting, and JSON/CSV export. Export uses the captured fetched result; it never reruns the query. JSON uses tagged values for bigint, bytes, missing and nonfinite numbers to preserve their meaning. CSV is a display-oriented export.

Defaults are 500 rows/result, 5 MiB result payload/run, 1 MiB console output/run, a 30-second deadline, one active run, and ten retained in-memory runs. PostgreSQL cursors bound managed fetch without appending SQL LIMIT clauses. Typed application-style `.all()` rejects truncated results instead of pretending they are complete. Limits on displayed TS output do not bound workload performed by a private driver.

Cancel asks the adapter to stop, then closes/terminates the worker if necessary. The UI distinguishes confirmed cancellation from **outcome unknown**. It never retries a write automatically. A stopped local process does not prove the database rolled back. Shutdown closes owned workers, cursors, pools and the listener.

Only display layout and file references are persisted automatically. Rows, bindings, results and credentials are not uploaded or saved as workspace history.
