# @typed-sql/build

Stable build and test integrations for SQL-file imports and compiled inline query plans.

Install the package as a development dependency alongside your selected build tool:

```sh
pnpm add -D @typed-sql/build
```

See the [installation tutorials](https://github.com/Lojhan/typed-sql/blob/main/docs/integrations/index.md) for Vite, Vitest, Jest, webpack, Rspack, Rsbuild, Next.js, esbuild, Rollup, Rolldown, Bun, native Node test runners, Astro, Nuxt, SvelteKit, and Wrangler/D1.

Build integrations use a saved schema snapshot. They do not introspect a database, install a database driver, or replace application typechecking.

MIT © typed-sql contributors
