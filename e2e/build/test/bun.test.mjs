import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert, describe, it } from "poku";
import { consumer, execution, writeEntry } from "../src/consumer.mjs";

const fixture = await consumer([]);
const bun = process.env.TYPED_SQL_BUN ?? "bun";
try {
  await describe("Native Bun integration", async () => {
    for (const mode of ["build", "runtime", "test"]) {
      await it(`Bun ${mode} compiles SQL and inline plans against bun:sqlite`, async () => {
        const root = await fixture.project(`bun-${mode}`);
        await writeEntry(root);
        await writeFile(
          join(root, "verify.mjs"),
          execution.replace(
            'import { DatabaseSync } from "node:sqlite";',
            'import { Database as DatabaseSync } from "bun:sqlite";',
          ),
        );
        const body = 'import * as queries from "./entry.ts"; import {verify} from "./verify.mjs";';
        if (mode === "test") {
          await writeFile(
            join(root, "query.test.ts"),
            `${body} import {test} from "bun:test"; test("executes compiled plans",async()=>{await verify(queries);});`,
          );
        } else if (mode === "runtime") {
          await writeFile(
            join(root, "runtime.mjs"),
            `${body} await verify(queries); console.log("compiled plans executed");`,
          );
        } else {
          await writeFile(
            join(root, "build.mjs"),
            'import {typedSql} from "@typed-sql/build/bun"; const result=await Bun.build({entrypoints:["./entry.ts"],outdir:"./dist",naming:"output.mjs",target:"bun",packages:"external",sourcemap:"external",plugins:[await typedSql()]}); if(!result.success) throw new AggregateError(result.logs,"Build failed"); import {verify} from "./verify.mjs"; await verify(await import("./dist/output.mjs")); console.log("compiled plans executed");',
          );
        }
        const args =
          mode === "test"
            ? ["test", "--preload", "@typed-sql/build/bun-register", "query.test.ts"]
            : mode === "runtime"
              ? ["--preload", "@typed-sql/build/bun-register", "runtime.mjs"]
              : ["build.mjs"];
        const result = await fixture.command(root, bun, args);
        assert.match(result.output, mode === "test" ? /1 pass/u : /compiled plans executed/u);
        await writeFile(join(root, "query.sql"), "SELECT nonexistent FROM account");
        const invalid = await fixture.command(root, bun, args, { allowFailure: true });
        assert.notEqual(invalid.code, 0);
        assert.match(invalid.output, /TSQ101.*Unknown column nonexistent/u);
      });
    }
  });
} finally {
  await fixture.close();
}
