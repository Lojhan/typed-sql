import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert, describe, it } from "poku";
import { consumer } from "../src/consumer.mjs";

const fixture = await consumer(["typescript", "@types/node"]);
try {
  await describe("Packed SQL declarations and optional hosts", async () => {
    await it("installs without build hosts or preview-backed packages", async () => {
      for (const name of [
        "next",
        "jest",
        "vite",
        "webpack",
        "rollup",
        "rolldown",
        "@rspack/core",
        "@typed-sql/cli",
        "@typed-sql/adapters",
        "pg",
        "mysql2",
        "@libsql/client",
        "@neondatabase/serverless",
        "postgres",
        "@typed-sql/ts-bridge",
        "@typed-sql/language-server",
      ]) {
        await assert.rejects(stat(join(fixture.directory, "node_modules", name)), /ENOENT/u);
      }
    });
    await it("generates consumable TypeScript declarations and rejects bad parameters and stale snapshots", async () => {
      const root = await fixture.project("types");
      await writeFile(
        join(root, "consumer.ts"),
        'import query from "./query.sql"; import type {Query} from "@typed-sql/core"; const result: Query<{id:number;email:string},readonly [number]> = query(1); void result;',
      );
      await fixture.command(root, "pnpm", ["exec", "typed-sql-build", "types"]);
      await fixture.command(root, "pnpm", ["exec", "tsc", "--noEmit"]);
      await fixture.command(root, "pnpm", ["exec", "typed-sql-build", "types", "--check"]);
      await writeFile(join(root, "consumer.ts"), 'import query from "./query.sql"; query("wrong");');
      const invalid = await fixture.command(root, "pnpm", ["exec", "tsc", "--noEmit"], { allowFailure: true });
      assert.notEqual(invalid.code, 0);
      assert.match(invalid.output, /string.*not assignable.*number/u);
      const schema = JSON.parse(await readFile(join(root, "schema.json"), "utf8"));
      schema.tables.account.columns.email.nullable = true;
      await writeFile(join(root, "schema.json"), JSON.stringify(schema));
      const stale = await fixture.command(root, "pnpm", ["exec", "typed-sql-build", "types", "--check"], {
        allowFailure: true,
      });
      assert.notEqual(stale.code, 0);
      assert.match(stale.output, /TSQ_BUILD_TYPES_STALE/u);
      await fixture.command(root, "pnpm", ["exec", "typed-sql-build", "types"]);
      assert.match(await readFile(join(root, "query.d.sql.ts"), "utf8"), /string \| null/u);
    });
  });
} finally {
  await fixture.close();
}

const hosts = await consumer([
  "typescript",
  "@types/node",
  "@types/bun",
  "@types/react",
  "@types/react-dom",
  "vite",
  "esbuild",
  "rollup",
  "rolldown",
  "webpack",
  "@rspack/core",
  "@rsbuild/core",
  "next",
]);
try {
  await it("public adapter types compose with the hosts' real TypeScript configuration types", async () => {
    const root = await hosts.project("host-types");
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2024",
          skipLibCheck: true,
          types: ["node", "bun"],
        },
        include: ["config.ts"],
      }),
    );
    await writeFile(
      join(root, "config.ts"),
      `import {defineConfig as viteConfig} from "vite";
import type {RollupOptions} from "rollup";
import type {RolldownOptions} from "rolldown";
import type {Configuration as WebpackConfig} from "webpack";
import type {Configuration as RspackConfig} from "@rspack/core";
import {defineConfig as rsbuildConfig} from "@rsbuild/core";
import type {BuildOptions as EsbuildConfig} from "esbuild";
import type {NextConfig} from "next";
import {typedSql as viteSql} from "@typed-sql/build/vite";
import {typedSql as rollupSql} from "@typed-sql/build/rollup";
import {typedSql as rolldownSql} from "@typed-sql/build/rolldown";
import {typedSql as webpackSql} from "@typed-sql/build/webpack";
import {typedSql as rspackSql} from "@typed-sql/build/rspack";
import {typedSql as rsbuildSql} from "@typed-sql/build/rsbuild";
import {typedSql as esbuildSql} from "@typed-sql/build/esbuild";
import {typedSql as bunSql} from "@typed-sql/build/bun";
import {withTypedSql} from "@typed-sql/build/next";
export const vite=viteConfig({plugins:[viteSql()]});
export const rollup:RollupOptions={plugins:[rollupSql()]};
export const rolldown:RolldownOptions={plugins:[rolldownSql()]};
export const webpack:WebpackConfig={plugins:[webpackSql()]};
export const rspack:RspackConfig={plugins:[rspackSql()]};
export const rsbuild=rsbuildConfig({plugins:[rsbuildSql()]});
export const esbuild:EsbuildConfig={plugins:[esbuildSql()]};
export const bun:Bun.BuildConfig={entrypoints:["./entry.ts"],plugins:[await bunSql()]};
export const next:NextConfig=withTypedSql({reactStrictMode:true});
`,
    );
    await hosts.command(root, "pnpm", ["exec", "tsc", "--noEmit"]);
  });
} finally {
  await hosts.close();
}
