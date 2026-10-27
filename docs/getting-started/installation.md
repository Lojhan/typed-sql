---
title: Choose packages
description: Install one typed-sql grammar, the stable compiler CLI, and an explicit application-owned database driver.
pageType: how-to
---

# Choose packages

Install one grammar for the database used by the application. Add the stable CLI as a development
dependency, then select a database driver explicitly—grammar packages never install or own one.

## Inspect a setup plan

`typed-sql init` prints a JSON setup plan without writing project files, importing configuration,
installing dependencies, or connecting to a database:

```sh
pnpm exec typed-sql init --grammar postgres --dry-run
pnpm exec typed-sql init --cwd . --package apps/api --grammar mysql --editor vscode --json
```

Choose `postgres`, `mysql`, or `sqlite` explicitly. Workspace roots require `--package` to select
an application. The planner detects package-manager declarations and lockfiles and refuses
conflicting choices. Existing configuration and dependency ranges are preserved, not certified
compatible. Proposed files, missing dependencies, scripts, and pending actions are separate fields.

An editor selection proposes project settings and extension recommendations. It does not install
an extension, grant workspace trust, or claim the editor is ready. Supply a real schema snapshot
before generation; `init` does not fabricate database metadata.

## Apply setup

Apply the proposed configuration explicitly:

```sh
pnpm exec typed-sql init --grammar postgres --editor vscode --apply
```

Setup adds missing dependencies and scripts to `package.json`, preserves existing dependency
ranges and custom commands, and keeps comments in editor JSONC files. Conflicting editor settings
remain unchanged and appear as warnings. VS Code settings select the native SDK for the current
platform; regenerate that setting when moving the project to another operating system or CPU.
Zed settings select typed-sql as the TypeScript provider. Install the corresponding
[editor integrations](../guides/editors.md) separately.

Dependency installation and a language-server check are separate options:

```sh
pnpm exec typed-sql init --grammar postgres --editor vscode --apply --install
pnpm exec typed-sql init --grammar postgres --editor vscode --apply --verify
```

`--install` invokes the detected package manager in the selected application directory using its
normal workspace behavior. Dependency lifecycle scripts are disabled unless `--allow-scripts`
is also supplied; the package manager's own approval policies still apply. Editor setup includes
the experimental language server. Existing installations are preserved.

`--verify` starts the application's installed language server and imports the application's
executable configuration. It checks the supported TypeScript beta backend over stdio. It does
not launch an editor. The JSON result distinguishes `config-written`, `installed`, and
`server-ready`; `hostVerified` remains false. A server startup check does not prove editor
provider ownership, completions, or schema refresh.

File application uses a lock, content hashes, and a private recovery journal under `.typed-sql/`.
Setup adds that directory to `.gitignore`. If a process is interrupted while applying files,
recover with:

```sh
pnpm exec typed-sql init --cwd path/to/application --recover
```

Recovery restores only files that still match the journal's proposed content and permissions;
it preserves concurrent user edits for reconciliation. Package-manager operations are outside
file recovery, so an installation failure may leave its lockfile or dependency tree partially
updated. The error reports the last completed setup state.

## Prerequisites

typed-sql requires Node.js 22.11 or newer. The compiler uses an exact supported TypeScript version;
check the current [compatibility matrix](../reference/compatibility.md#runtime-and-compiler) before
installing into an existing project.

## PostgreSQL

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add -D @typed-sql/cli typescript
```

Application code imports `sql` from `@typed-sql/postgres`. The optional runtime and introspection
adapter is an explicit subpath at `@typed-sql/postgres/pg` and loads the application's `pg` package.

[Continue with the PostgreSQL quickstart](./postgresql.md).

## MySQL

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript
```

Application code imports `sql` from `@typed-sql/mysql`. The adapter at
`@typed-sql/mysql/mysql2` loads the application's `mysql2` package.

[Continue with the MySQL quickstart](./mysql.md).

## SQLite

```sh
pnpm add @typed-sql/core @typed-sql/sqlite
pnpm add -D @typed-sql/cli typescript
```

Application code imports `sql` from `@typed-sql/sqlite`. The optional
`@typed-sql/sqlite/node-sqlite` adapter uses the built-in `node:sqlite` module on supported Node
versions, so there is no npm driver dependency.

[Continue with the SQLite quickstart](./sqlite.md).

## Optional packages

Add these only when their capability is used:

| Package | Use it for | Stability |
| --- | --- | --- |
| `@typed-sql/opentelemetry` and `@opentelemetry/api` | Translate neutral database observations into application-owned spans | Stable |
| `pg-cursor` | Cursor-backed PostgreSQL streams | Application dependency |
| `@typed-sql/language-server` | Exact hovers and SQL editor features | Experimental |

The language server owns its isolated TypeScript preview internally. It is not required for
generation, checking, or execution. See [Compiler and editor workflow](./compiler-and-editor.md).

## Dependency boundary

Keep driver packages in application dependencies even when a dialect happens to use their types.
This makes the selected protocol, connection configuration, pool, codecs, and lifecycle visible to
the application. [Compare direct driver use and adapters](../guides/adapters.md).
