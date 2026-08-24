import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { checkFile, compileSource, extractStaticQueries } from "../src/index.js";
import { postgres, type PostgresSchemaSnapshot } from "../../postgres/src/index.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, "../../../test/fixtures/success");
const schemaPath = resolve(fixtureDirectory, "schema.json");

await describe("TypeScript 7 compiler wrapper", async () => {
  await it("extracts static SQL and replaces interpolations with parameters", async () => {
    const source = 'import { sql as query } from "@typed-sql/postgres";\nconst q = query`SELECT id FROM users WHERE id = ${id}`;';
    const extracted = extractStaticQueries(source, (index) => `$${index}`, ["@typed-sql/postgres"]);
    strict.strictEqual(extracted.length, 1);
    strict.strictEqual(extracted[0]?.sql, "SELECT id FROM users WHERE id = $1");
    strict.strictEqual(extracted[0]?.parameterCount, 1);
  });

  await it("ignores non-query text and handles template and interpolation edge cases", () => {
    const placeholder = (index: number) => `?${index}`;
    strict.deepStrictEqual(extractStaticQueries("const sql = 1", placeholder), []);
    strict.deepStrictEqual(extractStaticQueries('import { sql } from "other"; sql`SELECT 1`', placeholder), []);
    strict.deepStrictEqual(extractStaticQueries('import { sql } from "./generated/db/index.js"; sql`SELECT 1`', placeholder, ["@typed-sql/postgres"]), []);
    const source = [
      'import { sql, sql as query } from "@typed-sql/core";',
      'const ignored = "query`SELECT ignored`";',
      '// sql`SELECT comment`',
      '/* query`SELECT block` */',
      'const first = sql `SELECT \\`value\\`, ${fn({ nested: "}" }, `x`)} AS value`;',
      'const second = query`SELECT ${(() => { /* } */ return 2; })()} AS value`;',
      'query + 1;',
    ].join("\n");
    const extracted = extractStaticQueries(source, placeholder);
    strict.strictEqual(extracted.length, 2);
    strict.ok(extracted[0]?.sql.includes("?1 AS value"));
    strict.strictEqual(extracted[1]?.sql, "SELECT ?1 AS value");
    strict.deepStrictEqual(extractStaticQueries('import { sql } from "@typed-sql/core"; sql`unterminated', placeholder), []);
    strict.deepStrictEqual(extractStaticQueries('import { sql } from "@typed-sql/core"; /* unterminated', placeholder), []);
    strict.deepStrictEqual(extractStaticQueries('import { sql } from "@typed-sql/core"; // unterminated', placeholder), []);
  });

  await it("injects an inferred row type without changing SQL text", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = 'import { sql } from "@typed-sql/postgres";\nconst q = sql`SELECT id FROM users`;';
    const result = compileSource({ source, schema: schema as PostgresSchemaSnapshot, dialect: postgres() });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.ok(result.transformedSource.includes('sql<{ "id": number; }>`SELECT id FROM users`'));
  });

  await it("injects CTE and DML RETURNING rows and command-only never results", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      'const selected = sql`WITH chosen AS (SELECT id FROM users) SELECT id FROM chosen`;',
      'const inserted = sql`INSERT INTO users (name) VALUES (${name}) RETURNING id`;',
      'const deleted = sql`DELETE FROM users WHERE id = ${id}`;',
    ].join("\n");
    const result = compileSource({ source, schema: schema as PostgresSchemaSnapshot, dialect: postgres() });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.queries[0]?.rowType, '{ "id": number; }');
    strict.strictEqual(result.queries[1]?.rowType, '{ "id": number; }');
    strict.strictEqual(result.queries[2]?.rowType, "never");
    strict.ok(result.transformedSource.includes("sql<never>`DELETE"));
  });

  await it("maps SQL diagnostics back to TypeScript source", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = 'import { sql } from "@typed-sql/postgres";\nconst q = sql`SELECT missing FROM users`;';
    const result = compileSource({ source, schema: schema as PostgresSchemaSnapshot, dialect: postgres() });
    strict.strictEqual(result.diagnostics[0]?.code, "TSQ101");
    strict.strictEqual(result.diagnostics[0]?.range.line, 2);
    strict.ok((result.diagnostics[0]?.range.column ?? 0) > 1);
  });

  await it("rejects dialect/schema mismatches and parse failures safely", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    strict.throws(() => compileSource({
      source: 'import { sql } from "@typed-sql/postgres"; sql`SELECT id FROM users`;',
      schema: { ...schema, dialect: "mysql" } as PostgresSchemaSnapshot,
      dialect: postgres(),
    }), /cannot compile/);
    const result = compileSource({
      source: 'import { sql } from "@typed-sql/postgres"; sql`SELECT`;',
      schema: schema as PostgresSchemaSnapshot,
      dialect: postgres(),
    });
    strict.strictEqual(result.diagnostics[0]?.code, "TSQ001");
    strict.strictEqual(result.queries.length, 0);
  });

  await it("rejects the compile-failure acceptance fixture", async () => {
    const result = await checkFile({
      file: resolve(testDirectory, "../../../test/fixtures/failure/query.ts"),
      schema: schemaPath,
      dialect: postgres(),
      runTypeScript: false,
    });
    strict.deepStrictEqual(result.sqlDiagnostics.map((diagnostic) => diagnostic.code), ["TSQ101", "TSQ105", "TSQ100"]);
    strict.strictEqual(result.ok, false);
    strict.ok(result.sqlDiagnostics.every((diagnostic) => diagnostic.range.line >= 3));
  });

  await it("checks the acceptance fixture with the native TypeScript 7 compiler", async () => {
    const result = await checkFile({
      file: resolve(fixtureDirectory, "query.ts"),
      schema: schemaPath,
      dialect: postgres(),
      project: resolve(fixtureDirectory, "tsconfig.json"),
    });
    strict.deepStrictEqual(result.sqlDiagnostics, []);
    strict.strictEqual(result.typeScript?.exitCode, 0, result.typeScript?.output);
    strict.strictEqual(result.ok, true);
  });

  await it("discovers tsconfig, accepts in-memory schemas, and reports TypeScript failures", async () => {
    const schema = await loadSchemaSnapshot(schemaPath) as PostgresSchemaSnapshot;
    const discovered = await checkFile({
      file: resolve(fixtureDirectory, "query.ts"),
      schema,
      dialect: postgres(),
    });
    strict.strictEqual(discovered.ok, true, discovered.typeScript?.output);

    const directory = await mkdtemp(join(tmpdir(), "typed-sql-compiler-"));
    try {
      const file = join(directory, "invalid.ts");
      await writeFile(file, 'import { sql } from "@typed-sql/postgres";\nconst query = sql`SELECT id FROM users`;\nconst invalid: number = "text";\n');
      const invalid = await checkFile({ file, schema, dialect: postgres(), project: resolve(fixtureDirectory, "tsconfig.json") });
      strict.strictEqual(invalid.ok, false);
      strict.ok((invalid.typeScript?.output.length ?? 0) > 0);
      await strict.rejects(() => checkFile({ file, schema, dialect: postgres() }), /Could not find tsconfig/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
