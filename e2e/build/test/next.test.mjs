import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert, describe, it } from "poku";
import { consumer, server, writeEntry } from "../src/consumer.mjs";

const fixture = await consumer(
  ["next", "react", "react-dom", "@types/react", "@types/react-dom", "@types/node", "typescript", "esbuild"],
  ["@typed-sql/cli"],
);
try {
  await describe("Next.js public configuration helper", async () => {
    for (const backend of ["turbopack", "webpack"]) {
      await it(`${backend} produces a real production server with SQL modules and inline plans`, async () => {
        const root = await fixture.project(`next-${backend}`);
        await writeEntry(root);
        await mkdir(join(root, "app/api/query"), { recursive: true });
        await writeFile(
          join(root, "app/layout.tsx"),
          "export default function Layout({children}:{children:React.ReactNode}) { return <html><body>{children}</body></html>; }",
        );
        await writeFile(join(root, "app/page.tsx"), "export default function Page(){return <main>typed-sql</main>;}");
        await writeFile(
          join(root, "app/api/query/route.ts"),
          'import * as queries from "../../../entry.ts"; import {verify} from "../../../verify.mjs"; export const runtime="nodejs"; export const dynamic="force-dynamic"; export async function GET(){await verify(queries); return Response.json({ok:true});}',
        );
        // Explicitly replace the built-in typecheck with the authoritative prebuild gate below.
        await writeFile(
          join(root, "next.config.mjs"),
          'import {withTypedSql} from "@typed-sql/build/next"; export default withTypedSql({typescript:{ignoreBuildErrors:true},serverExternalPackages:["@typed-sql/core","@typed-sql/sqlite"]},{cwd:process.cwd()});',
        );
        const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
        Object.assign(config.compilerOptions, {
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          allowImportingTsExtensions: true,
          allowJs: true,
          skipLibCheck: true,
          plugins: [{ name: "next" }],
        });
        config.include = ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"];
        await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
        await fixture.command(root, "pnpm", ["exec", "typed-sql-build", "types"]);
        await fixture.command(root, "pnpm", ["exec", "next", "typegen"], { env: { NEXT_TELEMETRY_DISABLED: "1" } });
        const downstream =
          'import type {Database} from "@typed-sql/core"; import {inline} from "./inline.ts"; declare const database:Database; const rows=await database.all(inline(1)); const email:string=rows[0]!.email; void email;';
        await writeFile(join(root, "downstream.ts"), downstream);
        await fixture.command(root, "pnpm", ["exec", "typed-sql", "check"]);
        await writeFile(join(root, "bad-consumer.ts"), 'import query from "./query.sql"; query("wrong");');
        const bad = await fixture.command(root, "pnpm", ["exec", "typed-sql", "check"], { allowFailure: true });
        assert.notEqual(bad.code, 0);
        assert.match(bad.output, /string.*not assignable.*number/u);
        await writeFile(join(root, "downstream.ts"), downstream.replace("email:string", "email:number"));
        const badInline = await fixture.command(root, "pnpm", ["exec", "typed-sql", "check"], { allowFailure: true });
        assert.notEqual(badInline.code, 0);
        assert.match(badInline.output, /Type 'string' is not assignable to type 'number'/u);
        await writeFile(join(root, "downstream.ts"), downstream);
        await writeFile(join(root, "bad-consumer.ts"), 'import query from "./query.sql"; query(1);');
        await fixture.command(root, "pnpm", ["exec", "typed-sql", "check"]);
        await fixture.command(root, "pnpm", ["exec", "next", "build", `--${backend}`], {
          timeout: 240_000,
          env: { NEXT_TELEMETRY_DISABLED: "1" },
        });
        const instance = await server(
          root,
          [
            join(fixture.directory, "node_modules/next/dist/bin/next"),
            "start",
            "--hostname",
            "127.0.0.1",
            "--port",
            "{port}",
          ],
          { NEXT_TELEMETRY_DISABLED: "1" },
        );
        try {
          assert.deepEqual(await (await instance.fetch("/api/query")).json(), { ok: true });
        } finally {
          await instance.close();
        }
      });
    }
  });
} finally {
  await fixture.close();
}
