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
    limits: { timeoutMs: 30_000, pageSize: 200, cursorIdleMs: 30_000 },
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

## Files and split views

The file tree shows actual files inside the repository, grouped by directory. The default writable query folder is `playground/`; change `scratchDirectory` and `writeRoots` to select another repository folder. Save, Save As and Rename operate on disk, so query files survive host and browser restarts and can be edited externally, committed and shared. Browser storage retains layout, open tabs and cursors rather than becoming the source of truth for file contents. Use a consistent `--port` to restore browser layout across host launches; repository files persist regardless of the port or browser. Unsaved buffers need an explicit save.

Use the file and folder buttons in **Files**, or right-click a folder or blank tree space. Creation starts an inline name field in the selected directory: Enter creates the actual file/folder, while Escape or leaving the field cancels. Empty folders remain visible and survive host restarts. Duplicate names produce a conflict instead of replacing existing work.

Open files as tabs and split a group left, right, above or below. Drag tabs between groups and resize the file tree, editor groups, inspector and results. The same file can be viewed in multiple groups with a shared edit buffer. Schema, Compare and Agent are workspace views alongside query tabs.

The color selector offers **System**, **Light** and **Dark**. System follows OS changes; an explicit preference stays in browser storage. Scrollbars float over non-editor scroll areas and fade after interaction, without reserving container space. The editor remains scrollable with no visible scrollbar.

## Explore and create a query

The board displays captured foreign keys, including composite and cross-schema keys. It never infers relationships from column names. Search relations/columns, focus neighbors, drag cards and reset the layout. Layout positions stay in local browser storage, outside the compiler snapshot. The schema list and inspector provide keyboard-accessible relation/column/constraint information.

Select a table and choose **New SQL query** or **New TS query** in its contextual actions. The workspace creates a grammar-qualified query under the configured query folder, chooses a nonconflicting filename and opens the actual file. TypeScript templates include a server-side `db.ts` helper:

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

Each run gets a fresh process and captured local ESM graph with source maps. Static imports, inline SQL and literal `.sql` imports are supported. Dynamic project imports, CommonJS files, `require()`, and local non-code assets such as JSON receive an explicit unsupported-graph diagnostic. Use static TypeScript/ESM data modules for captured local inputs. Installed external dependencies remain trusted and are checked by entry/package identity; this is not a hermetic build of arbitrary package side effects.

For a TypeScript file that imports a `.sql` file, select the SQL file, save it, then choose **Generate TS types**. The explicit action writes its compiler-only `.d.sql.ts` declaration inside the allowed write root. Regenerate after SQL changes, or use the application's existing [build integration](../integrations/index.md) to maintain declarations. Application-owned declarations are never overwritten. A missing/stale declaration blocks the TypeScript run; it is not bypassed with an untyped import.

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

The grid renders a virtual window and fetches bounded result pages as you scroll. Cell inspection, filtering and JSON/CSV export operate on the current captured page; they never silently fetch all rows or rerun the query. JSON uses tagged values for bigint, bytes, missing and nonfinite numbers to preserve their meaning. CSV is a display-oriented export.

There is no default total row cutoff. Defaults are 200 rows/page, 5 MiB/page, a 512 MiB private disk capture quota per result, 1 MiB console output/run, a 30-second active operation deadline, one active run and ten retained runs. Configure `pageSize`, `maxResultBytes`, `maxSpoolBytes`, `cursorIdleMs` and `timeoutMs` under `playground.limits`; an explicit `maxRows` is an optional total cap. Quota failures and configured caps retain incomplete evidence rather than claiming a complete result.

Read-only raw PostgreSQL results use a pinned cursor: the first page arrives before all rows are fetched, and scrolling requests subsequent pages without modifying SQL or re-executing it. Already captured pages remain available for backscroll and comparison. The cursor expires after 30 seconds without demand by default; **Close cursor**, cancellation and shutdown release it. Row counts remain lower bounds until exhaustion. Writes drain their result and confirm transaction completion before success; they do not leave an uncommitted write waiting for scrolling.

Typed application-style `.all()` materializes its result inside the worker before display paging. Paging its output does not make that API a streaming query, and worker memory bounds still apply. Private drivers retain their own execution and fetch behavior. Duplicate request IDs never replay an accepted operation; expired results produce an explicit diagnostic. Restart after 10,000 unique session runs.

Cancel asks the adapter to stop, then closes/terminates the worker if necessary. The UI distinguishes confirmed cancellation from **outcome unknown**. It never retries a write automatically. A stopped local process does not prove the database rolled back. Shutdown closes owned workers, cursors, pools and the listener.

Query files persist in the repository. Layout and open-file references persist in the browser. Captured result pages use private temporary disk storage for the current host session and are removed on eviction or shutdown; they are not committed as workspace history. Nothing is uploaded by the workspace itself. Agent conversations use the separate opt-in local storage described below.

## Compare captured queries

Choose two captured runs in **Compare** to inspect their results and measurements side by side. Each side retains its source revision, target, schema and type-policy identity, parameter fingerprint and terminal status. Timing fields show measurements where available; end-to-end elapsed time includes checking and worker startup, and is not a server execution benchmark. Cursor waiting time is not a claim about database performance.

Values align by column position. Column-name and type metadata differences are reported separately from value differences, so a changed alias does not color every matching row. Ordered comparison highlights changed cells and missing rows; unordered multiset comparison highlights unmatched rows while preserving duplicate counts. Tagged bigint/NULL/missing values remain distinct. Page comparisons describe the selected captured pages, not full-query equivalence. Partial captures and different source/schema/target contexts remain visible. Comparison does not execute either query, retry writes or run `EXPLAIN ANALYZE` automatically.

## Local agents and reviewed query tools

Open **Agent** to configure an existing local [ACP v1 stdio agent](https://agentclientprotocol.com/protocol/v1/initialization). Give the profile a name, an executable and a JSON array of arguments. Use an agent's documented ACP adapter command; an ordinary terminal chat command is not necessarily an ACP server. The host starts that executable directly, without a shell, only when you send a prompt after trusting the project. Complete the agent's own installation and login in a terminal first. Profiles do not install agents or initiate authentication automatically.

For an installed [OpenCode ACP server](https://dev.opencode.ai/docs/acp/), use executable `opencode` with arguments `["acp"]`. An absolute executable path works when the host does not inherit your terminal PATH. Choosing a preset fills the form; saving or prompting remains explicit.

Profiles live in the user's `agents.json`, under `$XDG_CONFIG_HOME/typed-sql/playground` or `~/.config/typed-sql/playground`. The file uses private permissions and is shared across projects. Command arguments remain on the host and are omitted from browser responses. Do not put credentials in command arguments; let the agent use its own local login or environment. This local process runs with your host permissions and can use a remote model according to its own configuration; ACP is an integration protocol, not a process sandbox.

Choose the source, schema or result context to attach before sending. Source context must match the saved file revision. Attachments are limited to 256 KiB. The client forwards only those selected attachments plus the conversation transcript; it does not automatically collect the database or project directory. Agents with their own filesystem tools may access additional host files under their own permissions. Review an agent's configuration before sharing sensitive data.

Assistant text streams into the conversation. The workspace persists messages and proposals in private, project-scoped user storage. A fresh ACP session receives the saved transcript each turn; this does not rely on agent-specific session loading. Stop cancels the turn and terminates the owned process group. Turns have a two-minute deadline, bounded output and at most two concurrent local processes. Authentication, malformed-protocol and process failures appear as failed turns rather than fabricated responses.

An agent can author reusable SQL or TypeScript tools through ACP's `fs/write_text_file` request. The workspace displays the complete existing/proposed source and requires **Accept** or **Reject**. Accept writes a real repository file inside the configured `writeRoots`, checked against the original revision. A stale proposal cannot overwrite an externally changed file. Reject, cancellation and restart leave pending changes unapplied. Files belong to the project and can be committed and shared like any other query file; agent profiles and conversation storage remain local to the user.

For agents that do not use client filesystem methods, a text response can include a fenced `typed-sql-tool` JSON block. The workspace turns it into the same reviewable file proposal:

````text
```typed-sql-tool
{"file":"playground/find-account.sql","source":"select id from public.accounts where id = $1;\n"}
```
````

Saving a proposed tool never executes it. Open the saved file in the editor, inspect its typed contract, and use the usual Run action and managed read-only/write controls. The client supplies no terminal capability and declines general agent permission requests. These controls govern the workspace's mediated file and query actions; they cannot restrict a trusted executable's independent operating-system access.
