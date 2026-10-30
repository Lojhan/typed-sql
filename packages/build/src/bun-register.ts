import { typedSql } from "./bun.js";

// Kept behind its own entrypoint so Node builds never resolve Bun's runtime module.
const specifier = "bun";
const { plugin } = (await import(specifier)) as { plugin(value: Awaited<ReturnType<typeof typedSql>>): void };
plugin(
  await typedSql({
    cwd: process.env.TYPED_SQL_BUILD_CWD ?? process.cwd(),
    ...(process.env.TYPED_SQL_BUILD_CONFIG === undefined ? {} : { config: process.env.TYPED_SQL_BUILD_CONFIG }),
  }),
);
