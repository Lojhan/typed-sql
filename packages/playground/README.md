# @typed-sql/playground

Stable-track optional local schema exploration and live TypeScript/SQL workspace for typed-sql projects.

```sh
pnpm add -D @typed-sql/playground
pnpm exec typed-sql playground
```

See the [local dev workspace guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/dev-workspace.md) for configuration, explicit PostgreSQL connection setup, execution modes, resource limits and trust boundaries.

Database drivers remain application-owned and load only through the explicit `@typed-sql/playground/pg` adapter. Offline analysis does not require a driver.

MIT © typed-sql
