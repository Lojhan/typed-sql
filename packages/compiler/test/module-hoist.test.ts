import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { it, strict } from "poku";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
import { compileSource } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");

await it("executes hoisted modules after every JavaScript hashbang line terminator", async () => {
  const schema = (await loadSchemaSnapshot(
    resolve(root, "test/fixtures/success/schema.json"),
  )) as PostgresSchemaSnapshot;
  const directory = await mkdtemp(resolve(root, "node_modules/.module-line-endings-"));
  try {
    for (const eol of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      const source = [
        "#!/usr/bin/env node",
        'import {sql} from "@typed-sql/postgres";',
        'import {getQueryValuePlan} from "@typed-sql/core";',
        "const q=sql`SELECT id FROM users`;",
        'process.stdout.write(getQueryValuePlan(q)?.dialect ?? "missing");',
      ].join(eol);
      const compiled = compileSource({ source, schema, dialect: postgres(), runtimeMetadata: true });
      strict.deepEqual(compiled.diagnostics, []);
      const file = resolve(directory, "query.ts");
      await writeFile(file, compiled.transformedSource);
      strict.equal(
        execFileSync(process.execPath, ["--import", "tsx", file], { cwd: root, encoding: "utf8" }),
        "postgres",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await it("analyzes the cooked CRLF template text that the JavaScript tag actually receives", async () => {
  const schema = (await loadSchemaSnapshot(
    resolve(root, "test/fixtures/success/schema.json"),
  )) as PostgresSchemaSnapshot;
  const source = [
    'import {sql} from "@typed-sql/postgres";',
    'import {postgresRenderer as renderer} from "@typed-sql/postgres/query";',
    'import {renderQuery} from "@typed-sql/core";',
    "const query=sql`SELECT\r\nid FROM users`;process.stdout.write(renderQuery(query,renderer).text);",
  ].join("\r\n");
  const compiled = compileSource({ source, schema, dialect: postgres(), runtimeMetadata: true });
  strict.deepEqual(compiled.diagnostics, []);
  const directory = await mkdtemp(resolve(root, "node_modules/.cooked-template-"));
  try {
    const file = resolve(directory, "query.ts");
    await writeFile(file, compiled.transformedSource);
    strict.equal(
      execFileSync(process.execPath, ["--import", "tsx", file], { cwd: root, encoding: "utf8" }),
      compiled.queries[0]?.query.sql,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
