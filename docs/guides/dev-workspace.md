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

In narrow panes, secondary toolbar controls move into labeled overflow menus instead of wrapping onto extra rows. Agent selectors and primary query actions stay visible; expand the corresponding action menu for configuration, exports or additional operations. Escape or clicking outside dismisses these menus.

Compact bottom-bar icons provide theme, connection, schema, comparison and agent controls without a global header. The theme icon offers **System**, **Light** and **Dark**. System follows OS changes; an explicit preference stays in browser storage. Scrollbars float over non-editor scroll areas and fade after interaction, without reserving container space. The editor remains scrollable with no visible scrollbar.

## Commands and file search

Press `Cmd/Ctrl+K`, or use the command icon in the bottom bar, to search file paths and available workspace actions. Use the arrow keys and Enter to select, and Escape to return to the previous focus. The palette opens files, Schema, Compare and Agent; creates files/folders; splits editor groups; changes theme; connects or refreshes a target; and exposes relevant save, rename, execution, cancellation and inspection actions.

**Find in active file** opens the editor's search panel. It searches the actual document with next/previous matches, case sensitivity and regular expressions. `Cmd/Ctrl+F` also opens it while the editor has focus. File lookup lives in the palette, so the file tree has no separate filter input. Search and navigation do not execute queries.

Use `Cmd/Ctrl+B` to show or hide the file tree, `Cmd/Ctrl+\\` to split right and `Cmd/Ctrl+Shift+\\` to split below. `Cmd/Ctrl+W` closes the active workspace tab and asks how to handle unsaved edits. `Cmd/Ctrl+Shift+P` also opens the command palette. Escape or clicking outside dismisses the palette and restores the previous focus. Workspace layout shortcuts are inactive while a dialog is open.

Choose **Format file** in the file-actions menu, **Format active file** in the palette, or press `Shift+Alt+F`. Formatting detects the nearest Biome or Prettier configuration and uses that formatter's project-installed package. It honors the repository's settings, including indentation and supported formatter plugins. The formatted source stays in the editor buffer until you save; Undo can restore it. If you edit while formatting runs, the newer buffer is preserved.

Repository formatters and executable configuration/plugins run locally with your user permissions, so enable trusted project execution for the session first. Nothing is installed automatically. Missing configuration, missing packages, ignored files and unsupported file types produce diagnostics. SQL formatting requires actual support in the installed formatter, such as a configured Prettier SQL plugin; the workspace does not guess a SQL layout or execute queries to format them.

## Editor intelligence

Install the optional [language server](./editors.md) in the project to enable TypeScript and SQL editor intelligence:

```sh
pnpm add -D @typed-sql/language-server
```

Enable trusted project execution for the session. The host starts the installed companion locally over stdio; it does not install a server, start one before trust, or send source to a hosted service. The companion owns the pinned TypeScript editor backend and typed-sql semantics. Its experimental integration stays separate from the stable workspace and compiler packages. The editor reports missing or unavailable capabilities explicitly.

Hover shows available type/query information. Suggestions appear while typing; `Ctrl+Space` or `Cmd+Space` requests them explicitly. `F12` and Cmd/Ctrl-click navigate to a definition. Right-click or `Shift+F10` opens editor actions, including navigation, suggestions, quick fixes, search and formatting. The command palette exposes the same language actions. Definition targets outside the editable roots open as bounded read-only documents, limited to the configured schema snapshot or verified installed dependency declarations.

Imports use the selected project's TypeScript resolution rules: a runtime `./db.js` specifier can navigate to `db.ts`, with the corresponding `.mjs`/`.mts` and `.cjs`/`.cts` behavior. JavaScript and JSX editing respects project `allowJs` and `checkJs` settings. ESM JavaScript queries use the same checked execution modes when the project permits them; CommonJS execution remains unsupported.

Unsaved working copies participate in analysis across tabs. Editing a helper and switching immediately to an importing query uses the helper's current buffer; discarding restores the disk version. Responses carry source, working-copy and snapshot identities so old suggestions, tooltips and fixes cannot overwrite newer context. Oversized working-copy contexts produce a diagnostic rather than silently analyzing an incomplete set.

Compiler and language-server errors appear inline and in **Problems**. Suggestions, hover, navigation and diagnostics use the current source overlay and project snapshot; they do not run queries. Quick fixes apply supported text edits to the current buffer after source checks, leaving saving explicit. The workspace does not automatically execute language-server commands or silently apply edits to unrelated files.

Explicit query execution can add PostgreSQL diagnostics with SQLSTATE evidence. A raw SQL error receives an inline range only when the executed query identity, compiler offset map and captured source prove its location. New edits or a newer run invalidate older markers. Errors without a proven location remain in the run/Problems view; TypeScript results and connection failures never receive guessed SQL spans. Inline database messages use fixed descriptions rather than copying server details that may contain values or SQL.

## Explore and create a query

The board displays captured foreign keys, including composite and cross-schema keys. It never infers relationships from column names. Search relations/columns, focus neighbors, drag cards and reset the layout. Layout positions stay in local browser storage, outside the compiler snapshot. The schema list and inspector provide keyboard-accessible relation/column/constraint information.

The project sidebar includes **Files**, **Database** and **Migrations**. Expand a database namespace to browse tables, views, columns, enums, indexes and constraints captured by the schema provider. Relationship links follow captured foreign keys and type references, including self references and composite keys. Select an object, or double-click a table on the schema board, to open its definition and history in a regular workspace tab; these tabs can be split and resized alongside query files. Relation details show captured columns, indexes, constraints and incoming/outgoing foreign keys as navigable sections. The raw captured definition is available in a collapsed disclosure.

The migration list combines local migration metadata with the selected target's recorded history. Applied, pending, reverted, interrupted and unverified states remain distinct. Opening the list does not execute TypeScript migration modules, apply SQL or create a migration ledger. The PostgreSQL playground adapter reads the existing ledger on its own selected connection; an absent ledger, missing permissions or an adapter without history support shows an unavailable state.

Object history uses recorded before/after catalog evidence, including changes to a table's columns, indexes and constraints. A rename can appear as a removal and addition; the workspace does not infer an identity that the evidence cannot establish. Reconciliation, baseline adoption, rolled-back attempts and uncertain outcomes retain their recorded meaning. Current local files are not treated as proof of SQL previously executed.

Detailed structural history requires the migration adapter's optional `captureDetails: true` setting when those migrations run. It records safe structural properties such as column types and enum labels alongside definition fingerprints. Existing fingerprint-only records still identify additions, removals and definition changes, but cannot reconstruct older definitions. Capturing details later does not retroactively fill those gaps. See [migration configuration](./migrations.md) for the migration target and history settings.

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

For Codex, install the [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) explicitly in a terminal:

```sh
npm install -g @agentclientprotocol/codex-acp
```

Complete your Codex CLI login in a terminal before sending a prompt. Choose the **Codex** preset: name `Codex`, executable `codex-acp`, arguments `[]`. The adapter uses your local Codex login; the workspace does not install it, collect credentials or start a login flow. Use an absolute path to `codex-acp` if the host does not inherit your terminal PATH. To use a particular installed Codex binary, set the adapter's `CODEX_PATH` in the host environment before starting the workspace.

For an installed [OpenCode ACP server](https://dev.opencode.ai/docs/acp/), use executable `opencode` with arguments `["acp"]`. An absolute executable path works when the host does not inherit your terminal PATH. Choosing a preset fills the form; saving or prompting remains explicit.

Profiles live in the user's `agents.json`, under `$XDG_CONFIG_HOME/typed-sql/playground` or `~/.config/typed-sql/playground`. The file uses private permissions and is shared across projects. Command arguments remain on the host and are omitted from browser responses. Do not put credentials in command arguments; let the agent use its own local login or environment. This local process runs with your host permissions and can use a remote model according to its own configuration; ACP is an integration protocol, not a process sandbox.

Choose the source, schema or result context to attach before sending. Source context must match the saved file revision. Attachments are limited to 256 KiB. The client forwards only those selected attachments plus the conversation transcript; it does not automatically collect the database or project directory. Agents with their own filesystem tools may access additional host files under their own permissions. Review an agent's configuration before sharing sensitive data.

**Workspace tools** has three modes: **Ask before use** (the default), **Allow for this conversation**, and **Off**. Ask shows the tool name and arguments before an operation runs, with **Allow once**, **Allow for this conversation**, and **Deny**. The mode is saved after sending a prompt and restored with the conversation. All modes still require project trust; allowing tools never bypasses read-only query enforcement or file-change review. Tool activity is grouped per turn and collapsed by default. Expand it for statuses and result details. The controls are unavailable when the host does not provide workspace tools.

Assistant text streams into the conversation. The workspace persists messages and proposals in private, project-scoped user storage. Switching tabs or reloading restores the selected profile and conversation after validating their IDs against the current project. Browser storage holds only those selection IDs; loading the transcript still requires project trust. A fresh ACP session receives the saved transcript each turn; this does not rely on agent-specific session loading. Stop cancels the turn and terminates the owned process group. Turns have a two-minute deadline, bounded output and at most two concurrent local processes. Authentication, malformed-protocol and process failures appear as failed turns rather than fabricated responses.

An agent can author reusable SQL or TypeScript tools through ACP's `fs/write_text_file` request. The workspace displays the complete existing/proposed source and requires **Accept** or **Reject**. Accept writes a real repository file inside the configured `writeRoots`, checked against the original revision. A stale proposal cannot overwrite an externally changed file. Reject, cancellation and restart leave pending changes unapplied. Files belong to the project and can be committed and shared like any other query file; agent profiles and conversation storage remain local to the user.

For agents that do not use client filesystem methods, a text response can include a fenced `typed-sql-tool` JSON block. The workspace turns it into the same reviewable file proposal:

````text
```typed-sql-tool
{"file":"playground/find-account.sql","source":"select id from public.accounts where id = $1;\n"}
```
````

Saving a proposed tool never executes it. Open the saved file in the editor, inspect its typed contract, and use the usual Run action and managed read-only/write controls. The client supplies no terminal capability and declines general agent permission requests. These controls govern the workspace's mediated file and query actions; they cannot restrict a trusted executable's independent operating-system access.


## Interactive agent analyses

Agent replies render Markdown headings, emphasis, lists, tables and highlighted SQL, TypeScript,
JavaScript and JSON. Code blocks have a copy action. External images and executable HTML are not
rendered. Messages, tool activity, file proposals and analyses share an ordered conversation timeline.
Scrolling up keeps the conversation in place while new output arrives; longer histories load earlier
activity on request.

With **Workspace tools** enabled, ask for an interactive breakdown, trend or hierarchy. The agent uses
`typed_sql_query_analysis` to capture checked, database-enforced read-only SQL, then
`typed_sql_present` to publish a validated presentation referencing that capture. It can inspect more
captured rows through `typed_sql_get_analysis_data`, without running SQL again. These tools remain
scoped to the current conversation and turn. Rendering a card does not execute model-generated code.

Analysis queries capture at most 1,000 rows with a 512 KiB structured-value budget and a five-second
deadline. Population counts and distributions should be aggregated in SQL. Cards visibly distinguish
complete query results from partial captures; a complete aggregate is distinct from a complete copy
of its underlying table. Captures retain the source query, parameter values, target identity, schema
and type-policy evidence, and timestamp in private project-scoped user storage.

Supported views include metrics, tables, bar and stacked bar, line and area, scatter, histogram,
pie and donut, sunburst and treemap, heatmap, funnel and Sankey. Metrics preserve exact integer and
decimal arithmetic within bounded precision; unsupported numeric magnitudes remain inspectable in
**Data** instead of being silently rounded into a chart. Metric views can include comparison deltas
and a trend. Hierarchies require ordered dimensions and nonnegative additive measures. Sankey flows
must be acyclic. Every chart has a data-table alternative.

Cards compose views in a stack or responsive grid and use the same controls as the rest of the
workspace. **Chart**, **Data** and **Query** expose the visualization, retained rows and source SQL.
Tables support searching, sorting, column visibility and value inspection. **Open in workspace**
creates a regular analysis tab that can split, resize and restore alongside query files.

Generated controls support selections, multiple selections, search, numeric comparisons, dates and
boolean switches. Captured-data filters reuse the saved rows. Controls marked **Runs query** bind
existing SQL parameters and require **Apply filters**; they never concatenate input into SQL. Query
refreshes check the target, observed server identity, schema and type policy. **Reset** restores the
original parameters. A refreshed card labels the original explanation as referring to its initial
capture. Agents can link chart selections to captured-data selection controls.

**Export captured data** downloads filtered captured rows as CSV or lossless JSON. It does not fetch
uncaptured database rows. Image exports support SVG and PNG. CSV exports protect spreadsheet formula
cells; JSON retains the original tagged values.

**Save analysis** writes a `.analysis.json` definition inside a configured project write root. The
file contains its query, parameter values, control definitions and presentation, with no captured
rows or connection credentials. Parameter values can themselves be sensitive; inspect the file
before committing it. Reopening the file exposes **Run saved analysis**: opening a definition alone
does not run SQL. Refreshing it creates a new private capture through the checked read-only path.
Schema changes require reviewing and updating the saved definition. Definitions are editable in
an external editor; their workspace view is an analysis launcher.

Private analysis storage is bounded independently of the transcript. Filter refreshes release
unreferenced intermediate captures. **Remove analysis** in an expanded analysis tab removes its
private card and unshared captures after confirmation, while retaining project definitions.
