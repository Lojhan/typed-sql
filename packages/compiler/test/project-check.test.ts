import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { postgres } from "../../postgres/src/index.js";
import { checkFile, checkProject } from "../src/index.js";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/success");
const schema = join(fixture, "schema.json");

await describe("project-wide native checking", async () => {
  await it("shares inferred contracts through aliases, re-exports and cross-file consumers without writing sources", async () => {
    const root = await mkdtemp(join(fixture, ".project-check-"));
    try {
      const query =
        'import { sql } from "@typed-sql/postgres";\nexport const byId = (id:number) => sql`SELECT id, name FROM users WHERE id = ${id}`;\n';
      const barrel = 'export { byId } from "./query.js";\n';
      const consumer =
        'import type {QueryRow} from "@typed-sql/core";\nimport { byId } from "#queries";\ndeclare const row: QueryRow<ReturnType<typeof byId>>;\nexport const name: string = row.name;\n';
      const project = join(root, "tsconfig.json");
      await writeFile(
        project,
        JSON.stringify({
          extends: "../tsconfig.json",
          compilerOptions: { declarationMap: false, paths: { "#queries": ["./barrel.ts"] }, ignoreDeprecations: "6.0" },
          files: ["consumer.ts"],
          include: [],
        }),
      );
      await writeFile(join(root, "query.ts"), query);
      await writeFile(join(root, "barrel.ts"), barrel);
      await writeFile(join(root, "consumer.ts"), consumer);
      const before = await readdir(root);
      const result = await checkProject({ project, schema, dialect: postgres() });
      strict.equal(result.ok, true, result.typeScript.output);
      strict.equal(
        result.files.find(({ file }) => file === join(root, "query.ts"))?.analysis.queries[0]?.rowType,
        '{ "id": number; "name": string; }',
      );
      strict.equal(
        (await checkFile({ file: join(root, "consumer.ts"), project, schema, dialect: postgres() })).ok,
        true,
      );
      strict.deepEqual(await readdir(root), before);
      strict.equal(await readFile(join(root, "query.ts"), "utf8"), query);
      strict.equal(await readFile(join(root, "consumer.ts"), "utf8"), consumer);
      await writeFile(join(root, "consumer.ts"), consumer.replace("name: string", "name: number"));
      const invalid = await checkProject({ project, schema, dialect: postgres() });
      strict.equal(invalid.ok, false);
      strict.match(
        invalid.typeScript.output,
        /consumer\.ts\(4,14\).*Type 'string' is not assignable to type 'number'/u,
      );
      await writeFile(join(root, "query.ts"), query.replace("SELECT id, name", "SELECT id, missing"));
      const badImport = await checkFile({ file: join(root, "consumer.ts"), project, schema, dialect: postgres() });
      strict.equal(badImport.ok, false);
      strict.ok(badImport.sqlDiagnostics.some((diagnostic) => diagnostic.code === "TSQ101"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await it("maps multi-line and Unicode parameter diagnostics onto original source positions", async () => {
    const root = await mkdtemp(join(fixture, ".project-locations-"));
    try {
      const file = join(root, "query.ts");
      const source =
        'import {sql} from "@typed-sql/postgres";\nconst label="😀";\nconst wrong="text";\nexport const a=sql`SELECT id FROM users WHERE id = ${wrong}`;\nexport const b=sql`SELECT id FROM users WHERE id = ${wrong}`;\n';
      await writeFile(file, source);
      const result = await checkFile({ file, project: join(fixture, "tsconfig.json"), schema, dialect: postgres() });
      strict.equal(result.ok, false);
      for (const line of [4, 5]) {
        const text = source.split("\n")[line - 1]!;
        const column = text.indexOf("wrong") + 1;
        strict.ok(result.typeScript?.output.includes(`query.ts(${line},${column})`), result.typeScript?.output);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
