---
title: Compiler and editor workflow
description: Understand authoritative typed-sql checking, conservative declarations, and optional experimental editor inference.
pageType: explanation
---

# Compiler and editor workflow

typed-sql has one analysis model exposed through three different development surfaces. They do not
have the same stability or responsibility.

| Surface | What it provides | Status | Correctness role |
| --- | --- | --- | --- |
| `typed-sql check` | Whole-project or file checks using the configured grammar and snapshot | Stable | Authoritative for CI and local verification |
| Published TypeScript declarations | Safe library types without a compiler overlay | Stable | Conservative baseline; queries can appear as `Query<unknown>` |
| typed-sql language server | Exact query/downstream hovers, SQL diagnostics, completion, definitions, and fixes | Experimental | Development aid using the same analysis evidence |

## Use the stable check

Run the compiler check after generating the configured schema snapshot:

```sh
pnpm exec typed-sql check --project tsconfig.json
```

Use `--file src/query.ts` to focus a local check. The command validates the workspace TypeScript
version, applies an in-memory semantic overlay to the project and its imported application modules, and does not rewrite
application source.

CI should run the same command. Use `typed-sql check` as the project's typechecking command, including downstream consumers of
query factories. Use the application's transpiler or bundler for JavaScript output after this check;
the checker does not emit JavaScript or declarations. For example:

```json
{
  "scripts": {
    "typecheck": "typed-sql check",
    "build": "pnpm run typecheck && vite build"
  }
}
```

Replace `vite build` with the application's existing transpilation command. A separate ordinary
`tsc` pass sees the conservative declarations rather than the inferred overlay, so it can report
`unknown` for the same query consumers. It is not an equivalent replacement for this typecheck.
Use `typed-sql check --show-types` to print the inferred contracts.

## Why normal TypeScript can show `unknown`

The public `sql` tag deliberately defaults its row type to `unknown`. That is the safe result when no
typed-sql compiler has analyzed the complete template against a schema. Publishing an optimistic type
would hide unsupported, ambiguous, dynamic, or stale input.

The typed-sql compiler proves a more specific contract only when all required evidence is available.
Unsupported analysis produces a diagnostic or preserves `unknown`; it never falls back to `any`.

## Add editor inference optionally

The language server runs the same source-analysis service and adds exact semantic information before
its isolated TypeScript preview checks the program. Applications install the language server, not the
preview compiler it owns internally.

Do not run another TypeScript language server for the same files while using the typed-sql proxy. The
ordinary server sees the conservative declarations and can publish competing `Query<unknown>` hovers
or diagnostics.

See [Editor setup](../guides/editors.md) for Zed, VS Code, and generic LSP configuration. If editor
startup fails, keep the stable CLI check in place and use `typed-sql doctor` to inspect the optional
integration.

## Keep the boundaries clear

- Editor inference does not participate in runtime execution.
- A database connection is not required during ordinary checking or editing once the snapshot exists.
- The generated snapshot is evidence, not an application import surface.
- The selected grammar owns SQL syntax and semantics; the compiler does not assume PostgreSQL behavior
  for MySQL, SQLite, or a third-party grammar.
- Exact supported TypeScript and editor versions are listed in [Compatibility](../reference/compatibility.md).
