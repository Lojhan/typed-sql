import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { checkFile, compileSource, extractAppendFragments, extractStaticQueries } from "../src/index.js";
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

  await it("extracts append fragments with placeholders offset by their base query", () => {
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      'const minimum = 1;',
      'const base = sql`SELECT id FROM users WHERE id >= ${minimum} AND TRUE`;',
      'const query = sql.append(base, sql.fragment` AND users.name = ${"Ada"}`);',
    ].join("\n");
    const queries = extractStaticQueries(source, (index) => `$${index}`, ["@typed-sql/postgres"]);
    const fragments = extractAppendFragments(source, (index) => `$${index}`, ["@typed-sql/postgres"], queries);
    strict.strictEqual(fragments.length, 1);
    strict.strictEqual(fragments[0]?.base.sql, "SELECT id FROM users WHERE id >= $1 AND TRUE");
    strict.strictEqual(fragments[0]?.fragment.sql, " AND users.name = $2");
    strict.strictEqual(fragments[0]?.fragment.parameterCount, 1);
    strict.strictEqual(fragments[0]?.parameterOffset, 1);
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

  await it("parses multiline and commented SQL imports without regular-expression backtracking", () => {
    const source = [
      "import {",
      "  type Query,",
      "  sql /* public tag */ as",
      "    query,",
      '} from "@typed-sql/core";',
      "const result = query`SELECT 1 AS value`;",
    ].join("\n");
    const extracted = extractStaticQueries(source, (index) => `$${index}`);
    strict.strictEqual(extracted.length, 1);
    strict.strictEqual(extracted[0]?.tagName, "query");
    strict.strictEqual(extracted[0]?.sql, "SELECT 1 AS value");
  });

  await it("injects an inferred row type without changing SQL text", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = 'import { sql } from "@typed-sql/postgres";\nconst q = sql`SELECT id FROM users`;';
    const result = compileSource({ source, schema: schema as PostgresSchemaSnapshot, dialect: postgres() });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.ok(result.transformedSource.includes('sql<{ "id": number; }, readonly []>`SELECT id FROM users`'));
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
    strict.strictEqual(result.queries[0]?.parameterType, "readonly []");
    strict.strictEqual(result.queries[1]?.rowType, '{ "id": number; }');
    strict.strictEqual(result.queries[1]?.parameterType, "readonly [string]");
    strict.strictEqual(result.queries[2]?.rowType, "never");
    strict.strictEqual(result.queries[2]?.parameterType, "readonly [number]");
    strict.ok(result.transformedSource.includes("sql<never, readonly [number]>`DELETE"));
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

  await it("rejects an interpolation whose TypeScript type does not match its SQL position", async () => {
    const directory = await mkdtemp(join(fixtureDirectory, ".typed-sql-params-"));
    try {
      const file = join(directory, "wrong-parameter.ts");
      await writeFile(file, [
        'import { sql } from "@typed-sql/postgres";',
        'const id = "not-a-number";',
        'export const query = sql`SELECT id FROM users WHERE id = ${id}`;',
      ].join("\n"));
      const result = await checkFile({
        file,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.deepStrictEqual(result.sqlDiagnostics, []);
      strict.notStrictEqual(result.typeScript?.exitCode, 0, result.typeScript?.output);
      strict.ok(result.typeScript?.output.includes("not assignable to parameter of type 'number'"), result.typeScript?.output);
      strict.ok(result.transformedSource.includes('readonly [number]>`SELECT'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("carries compiler-inferred column types through nullable composed filters", async () => {
    const directory = await mkdtemp(join(fixtureDirectory, ".typed-sql-filters-"));
    try {
      const validFile = join(directory, "composed-filters.ts");
      const shared = [
        'import { sql } from "@typed-sql/postgres";',
        'import type { QueryParameters, QueryRow } from "@typed-sql/core";',
        'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
        'type Assert<T extends true> = T;',
        'const base = sql`SELECT id, name FROM users`;',
        'const appendBase = sql`SELECT id, name FROM users`;',
        'type User = QueryRow<typeof base>;',
        'type Filters = { readonly id?: User["id"] | null; readonly name?: User["name"] | null };',
        'function users(filters: Filters, mode: "all" | "any") {',
        '  const predicates = [',
        '    filters.id == null ? undefined : sql.fragment`users.id = ${filters.id}`,',
        '    filters.name == null ? undefined : sql.fragment`users.name = ${filters.name}`,',
        '  ] as const;',
        '  return sql.where(base, mode === "all" ? sql.and(predicates) : sql.or(predicates));',
        '}',
        'function users2(filters: Filters) {',
        '  return sql.append(',
        '    appendBase,',
        '    sql.fragment` WHERE 1 = 1`,',
        '    filters.id == null ? undefined : sql.fragment` AND users.id = ${filters.id}`,',
        '    filters.name == null ? undefined : sql.fragment` AND users.name = ${filters.name}`,',
        '  );',
        '}',
      ];
      await writeFile(validFile, [...shared,
        'const query = users({ id: 1, name: "Ada" }, "all");',
        'const query2 = users2({ id: 1, name: "Ada" });',
        'const exact: Assert<Equal<QueryParameters<typeof query>, readonly [number, string]>> = true;',
        'const exact2: Assert<Equal<QueryParameters<typeof query2>, readonly [number, string]>> = true;',
        'void exact;',
        'void exact2;',
      ].join("\n"));
      const valid = await checkFile({
        file: validFile,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.strictEqual(valid.ok, true, valid.typeScript?.output);
      strict.ok(valid.transformedSource.includes('sql.fragment<readonly [number]>` AND users.id'));
      strict.ok(valid.transformedSource.includes('sql.fragment<readonly [string]>` AND users.name'));

      const invalidFile = join(directory, "invalid-composed-filter.ts");
      await writeFile(invalidFile, [...shared,
        'users({ id: "not-a-number" }, "all");',
        'sql.append(appendBase, sql.fragment` WHERE 1 = 1`, sql.fragment` AND users.id = ${"not-a-number"}`);',
      ].join("\n"));
      const invalid = await checkFile({
        file: invalidFile,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.strictEqual(invalid.ok, false);
      strict.ok(invalid.typeScript?.output.includes("not assignable to type 'number'"), invalid.typeScript?.output);
      strict.ok(invalid.typeScript?.output.includes("not assignable to parameter of type 'number'"), invalid.typeScript?.output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("infers conditional structural SELECT fragments without replacing SQL with a builder", async () => {
    const directory = await mkdtemp(join(fixtureDirectory, ".typed-sql-structural-"));
    try {
      const file = join(directory, "conditional-select.ts");
      await writeFile(file, [
        'import { sql } from "@typed-sql/postgres";',
        'import type { QueryRow } from "@typed-sql/core";',
        'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
        'type Assert<T extends true> = T;',
        'interface Filters { readonly id?: number | null }',
        'interface Selection { readonly age: boolean }',
        'function users<const Select extends Selection>(filters: Filters, select: Select) {',
        '  return sql`',
        '    SELECT users.id, users.name',
        '      ${select.age ? sql.fragment`, users.age` : sql.empty}',
        '    FROM users',
        '    WHERE 1 = 1',
        '      ${filters.id == null ? sql.empty : sql.fragment`AND users.id >= ${filters.id}`}',
        '  `;',
        '}',
        'const basic = users({}, { age: false });',
        'const detailed = users({}, { age: true });',
        'const basicRow: Assert<Equal<QueryRow<typeof basic>, { id: number; name: string }>> = true;',
        'const detailedRow: Assert<Equal<QueryRow<typeof detailed>, { id: number; name: string; age: number | null }>> = true;',
        'void basicRow; void detailedRow;',
      ].join("\n"));
      const result = await checkFile({
        file,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.deepStrictEqual(result.sqlDiagnostics, []);
      strict.strictEqual(result.ok, true, result.typeScript?.output);
      strict.ok(result.transformedSource.includes("sql.withRow<Select[\"age\"] extends true"));
      strict.ok(result.transformedSource.includes('sql.fragment<readonly [number]>`AND users.id'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
