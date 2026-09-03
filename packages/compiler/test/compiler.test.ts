import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import {
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  type SchemaSnapshot,
  unknownQuerySemantics,
} from "../../core/src/index.js";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
import { checkFile, compileSource, extractStaticQueries, mapSqlRange } from "../src/index.js";
import {
  extractAppendFragments,
  extractStructuralOperand,
  findUntaggedStructuralTemplates,
  parseStructuralInterpolation,
} from "../src/scanner.js";
import { structuralRowType } from "../src/structural.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, "../../../test/fixtures/success");
const schemaPath = resolve(fixtureDirectory, "schema.json");

await describe("TypeScript 7 compiler wrapper", async () => {
  await it("extracts static SQL and replaces interpolations with parameters", async () => {
    const source =
      'import { sql as query } from "@typed-sql/postgres";\nconst q = query`SELECT id FROM users WHERE id = ${id}`;';
    const extracted = extractStaticQueries(source, (index) => `$${index}`, ["@typed-sql/postgres"]);
    strict.strictEqual(extracted.length, 1);
    strict.strictEqual(extracted[0]?.sql, "SELECT id FROM users WHERE id = $1");
    strict.strictEqual(extracted[0]?.parameterCount, 1);
  });

  await it("extracts append fragments with placeholders offset by their base query", () => {
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      "const minimum = 1;",
      "const base = sql`SELECT id FROM users WHERE id >= ${minimum} AND TRUE`;",
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
    strict.deepStrictEqual(
      extractStaticQueries('import { sql } from "./generated/db/index.js"; sql`SELECT 1`', placeholder, [
        "@typed-sql/postgres",
      ]),
      [],
    );
    const source = [
      'import { sql, sql as query } from "@typed-sql/core";',
      'const ignored = "query`SELECT ignored`";',
      "// sql`SELECT comment`",
      "/* query`SELECT block` */",
      'const first = sql `SELECT \\`value\\`, ${fn({ nested: "}" }, `x`)} AS value`;',
      "const second = query`SELECT ${(() => { /* } */ return 2; })()} AS value`;",
      "query + 1;",
    ].join("\n");
    const extracted = extractStaticQueries(source, placeholder);
    strict.strictEqual(extracted.length, 2);
    strict.ok(extracted[0]?.sql.includes("?1 AS value"));
    strict.strictEqual(extracted[1]?.sql, "SELECT ?1 AS value");
    strict.deepStrictEqual(
      extractStaticQueries('import { sql } from "@typed-sql/core"; sql`unterminated', placeholder),
      [],
    );
    strict.deepStrictEqual(
      extractStaticQueries('import { sql } from "@typed-sql/core"; /* unterminated', placeholder),
      [],
    );
    strict.deepStrictEqual(
      extractStaticQueries('import { sql } from "@typed-sql/core"; // unterminated', placeholder),
      [],
    );
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

  await it("matches cooked template escapes and parenthesized structural expressions", () => {
    const escaped =
      'import { sql } from "@typed-sql/core";\nconst query = sql`SELECT \\u0031 AS one, \\x32 AS two, \\u{1F600} AS face, \\n AS newline`;';
    const extracted = extractStaticQueries(escaped, (index) => `$${index}`);
    strict.strictEqual(extracted[0]?.sql, "SELECT 1 AS one, 2 AS two, 😀 AS face, \n AS newline");
    const continued = 'import { sql } from "@typed-sql/core"; sql`SELECT \\\r\n1 AS crlf, \\\r2 AS cr, \\\n3 AS lf`;';
    strict.strictEqual(
      extractStaticQueries(continued, (index) => `$${index}`)[0]?.sql,
      "SELECT 1 AS crlf, 2 AS cr, 3 AS lf",
    );
    for (const invalid of ["\\8", "\\01", "\\xGG", "\\uZZZZ", "\\u{}", "\\u{1234567}", "\\u{110000}"]) {
      strict.deepStrictEqual(
        extractStaticQueries(`import { sql } from "@typed-sql/core"; sql\`SELECT ${invalid}\``, (index) => `$${index}`),
        [],
      );
    }

    const conditional = [
      'import { sql } from "@typed-sql/core";',
      "const query = sql`SELECT 1${(select.status ? sql.fragment`, 2 AS two` : sql.empty)}`;",
    ].join("\n");
    const query = extractStaticQueries(conditional, (index) => `$${index}`)[0]!;
    const structural = parseStructuralInterpolation(conditional, query.interpolations[0]!, "sql");
    strict.strictEqual(structural?.condition, "select.status");
    strict.strictEqual(structural?.truthy.kind, "fragment");
    strict.strictEqual(structural?.falsy?.kind, "empty");
  });

  await it("finds only bare templates paired with trusted structural branches", () => {
    const source = [
      'import { sql as querySql } from "@typed-sql/core";',
      'const hostile = "\' OR TRUE --";',
      "const query = querySql`SELECT users.id",
      "  ${select.name ? `, users.name` : querySql.empty}",
      "  FROM users WHERE users.name <> ${`${`${hostile}`}%`}",
      "  ${filters.name == null ? querySql.empty : (`AND users.name = ${filters.name}`)}`;",
    ].join("\n");
    const query = extractStaticQueries(source, (index) => `$${index}`)[0]!;
    const templates = findUntaggedStructuralTemplates(source, query);
    strict.strictEqual(templates.length, 2);
    strict.deepStrictEqual(
      templates.map(({ tagName, range }) => ({ tagName, text: source.slice(range.start, range.end) })),
      [
        { tagName: "querySql", text: "`, users.name`" },
        { tagName: "querySql", text: "`AND users.name = ${filters.name}`" },
      ],
    );
  });

  await it("preserves inline generic selection types for computed structural properties", () => {
    const schema = { formatVersion: 1, dialect: "inline", tables: {} } as const satisfies SchemaSnapshot;
    const inlineDialect: DialectPlugin<typeof schema, Record<string, never>> = {
      contractVersion: DIALECT_CONTRACT_VERSION,
      id: "inline",
      grammarVersion: "1",
      sqlModule: "@example/inline-sql",
      capabilities: {},
      defaultTypePolicy: {},
      placeholder: (index) => `$${index}`,
      quoteIdentifier: (identifier) => `"${identifier}"`,
      validateSnapshot: () => schema,
      analyze: (sql) => ({
        columns: [
          { name: "id", tsType: "number", nullable: false, range: { start: 7, end: 8, line: 1, column: 8 } },
          ...(sql.includes("status")
            ? [
                {
                  name: "status",
                  tsType: '"active" | "suspended"',
                  nullable: false,
                  range: { start: 10, end: 16, line: 1, column: 11 },
                },
              ]
            : []),
        ],
        parameters: [],
        diagnostics: [],
        resultKind: "rows" as const,
        semantics: unknownQuerySemantics({ start: 0, end: sql.length, line: 1, column: 1 }, "Test grammar"),
      }),
    };
    const source = [
      'import { sql } from "@example/inline-sql";',
      'function accounts(select: { readonly status: boolean; readonly mode: "all" | "any" }) {',
      '  return sql`SELECT 1 AS id${select["status"] ? sql.fragment`, status` : sql.empty}`;',
      "}",
    ].join("\n");
    const result = compileSource({ source, schema, dialect: inlineDialect });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.queries.length, 1);
    strict.ok(
      result.transformedSource.includes(
        '({ readonly status: boolean; readonly mode: "all" | "any" })["status"] extends true',
      ),
    );
  });

  await it("handles adversarial structural syntax and source-range fallbacks", () => {
    const source = [
      'import { sql } from "@typed-sql/core";',
      'function query(select: Readonly<{ readonly tuple: readonly ["x", "y"]; readonly status: boolean }>) {',
      "  const direct = sql`SELECT 1${sql.empty}`;",
      "  return sql`SELECT 1${((select?.status ?? false) ? sql.fragment` , 2 AS two` : sql.empty)}`;",
      "}",
    ].join("\n");
    const queries = extractStaticQueries(source, (index) => `$${index}`);
    const direct = queries[0];
    const conditional = queries[1];
    strict.ok(direct !== undefined);
    strict.ok(conditional !== undefined);
    const directStructure = parseStructuralInterpolation(source, direct!.interpolations[0]!, "sql");
    strict.strictEqual(directStructure?.truthy.kind, "empty");
    strict.strictEqual(
      extractStructuralOperand(source, directStructure!.truthy, "sql", (index) => `$${index}`, 0),
      undefined,
    );
    strict.strictEqual(
      parseStructuralInterpolation(source, conditional!.interpolations[0]!, "sql")?.truthy.kind,
      "fragment",
    );

    const original = conditional!;
    const conditionalType = structuralRowType(source, original, [
      { row: "Left extends true ? A : B", choices: new Map([["select.status", true]]) },
      { row: "C", choices: new Map([["select.status", false]]) },
    ]);
    strict.ok(conditionalType.includes("Readonly<"));
    strict.ok(conditionalType.includes("(Left extends true ? A : B)"));
    strict.strictEqual(structuralRowType(source, original, [{ row: "A", choices: new Map() }]), "A");
    strict.strictEqual(
      structuralRowType(source, original, [
        { row: "A", choices: new Map() },
        { row: "B", choices: new Map() },
      ]),
      "A | B",
    );
    strict.strictEqual(
      structuralRowType(source, original, [
        { row: "A", choices: new Map([["unknown.expression", true]]) },
        { row: "B", choices: new Map([["unknown.expression", false]]) },
      ]),
      "A | B",
    );
    strict.strictEqual(
      structuralRowType(source, original, [
        { row: "A", choices: new Map([["select.status", true]]) },
        { row: "B", choices: new Map([["select.status", true]]) },
      ]),
      "A | B",
    );
    strict.strictEqual(
      structuralRowType(source, original, [
        { row: "A", choices: new Map([["select.status", true]]) },
        { row: "A", choices: new Map([["select.status", false]]) },
      ]),
      "A",
    );

    const mappedEmpty = mapSqlRange(source, original, { start: 99_999, end: 99_999, line: 1, column: 1 });
    strict.strictEqual(mappedEmpty.start, original.range.start);
    const mappedPastEnd = mapSqlRange(source, original, { start: 0, end: 99_999, line: 1, column: 1 });
    strict.ok(mappedPastEnd.end >= mappedPastEnd.start);
  });

  await it("fails closed across malformed imports, fragments, and append calls", () => {
    const placeholder = (index: number) => `$${index}`;
    for (const malformed of [
      'import sql from "@typed-sql/core"; sql`SELECT 1`',
      'import { sql } "@typed-sql/core"; sql`SELECT 1`',
      "import { sql } from core; sql`SELECT 1`",
      'import { sql } from "@typed-sql/core; sql`SELECT 1`',
      'import { sql as } from "@typed-sql/core"; sql`SELECT 1`',
      'import { sql from "@typed-sql/core"; sql`SELECT 1`',
    ]) {
      strict.deepStrictEqual(extractStaticQueries(malformed, placeholder), []);
    }

    for (let index = 0; index < 12; index += 1) {
      const scanned = extractStaticQueries(
        `import { sql } from "@typed-sql/core";\n\nconst q${index} = sql\`SELECT ${index}\`;`,
        placeholder,
      );
      strict.strictEqual(scanned[0]?.range.line, 3);
    }

    const appendSource = [
      'import { sql } from "@typed-sql/core";',
      "const base = sql`SELECT 1`;",
      "sql.append((base), sql.fragment` WHERE FALSE`);",
      "sql.append(base /* base */, 'ignored', `ignored`, // comment",
      "  /* block */ sql.fragment` WHERE one = ${1}`, sql.fragment` AND two = ${2}`);",
      "sql.other(base, sql.fragment` WHERE FALSE`);",
      "sql.append(base, sql.other` WHERE FALSE`);",
      "sql.append(base, sql.fragment);",
      "sql.append(base",
    ].join("\n");
    const queries = extractStaticQueries(appendSource, placeholder);
    const fragments = extractAppendFragments(appendSource, placeholder, undefined, queries);
    strict.strictEqual(fragments.length, 2);
    strict.strictEqual(fragments[0]?.fragment.sql, " WHERE one = $1");
    strict.strictEqual(fragments[1]?.fragment.sql, " AND two = $2");
    strict.strictEqual(fragments[1]?.prefix.length, 1);
    strict.deepStrictEqual(extractAppendFragments('import { value } from "other";', placeholder), []);
  });

  await it("deduplicates variant diagnostics and rejects incompatible fragment contexts", () => {
    const schema = { formatVersion: 1, dialect: "test", tables: {} } as const satisfies SchemaSnapshot;
    const diagnosticDialect: DialectPlugin<typeof schema, Record<string, never>> = {
      contractVersion: DIALECT_CONTRACT_VERSION,
      id: "test",
      grammarVersion: "1",
      sqlModule: "@example/test-sql",
      capabilities: {},
      defaultTypePolicy: {},
      placeholder: (index) => `$${index}`,
      quoteIdentifier: (identifier) => `"${identifier}"`,
      validateSnapshot: () => schema,
      analyze: () => ({
        columns: [],
        parameters: [],
        diagnostics: [
          {
            code: "TSQ101",
            message: "Unknown column",
            severity: "error",
            range: { start: 7, end: 9, line: 1, column: 8 },
          },
        ],
        semantics: unknownQuerySemantics({ start: 0, end: 1, line: 1, column: 1 }, "Test diagnostic"),
      }),
    };
    const conditional =
      'import { sql } from "@example/test-sql"; sql`SELECT id${select.more ? sql.fragment`, more` : sql.empty}`;';
    const diagnosed = compileSource({ source: conditional, schema, dialect: diagnosticDialect });
    strict.strictEqual(diagnosed.diagnostics.length, 1);

    const contextualDialect: DialectPlugin<typeof schema, Record<string, never>> = {
      ...diagnosticDialect,
      analyze: (sql) => ({
        columns: [{ name: "id", tsType: "number", nullable: false, range: { start: 7, end: 9, line: 1, column: 8 } }],
        parameters: [{ index: 1, tsType: sql.includes("users AS account") ? "number" : "string", nullable: false }],
        diagnostics: [],
        resultKind: "rows",
        semantics: unknownQuerySemantics({ start: 0, end: sql.length, line: 1, column: 1 }, "Test grammar"),
      }),
    };
    const contextual = [
      'import { sql } from "@example/test-sql";',
      "const query = sql`SELECT account.id FROM",
      "  ${select.users ? sql.fragment`users AS account` : sql.fragment`projects AS account`}",
      "  WHERE 1 = 1 ${sql.fragment`AND account.id = ${value}`}`;",
    ].join("\n");
    const conflicted = compileSource({ source: contextual, schema, dialect: contextualDialect });
    strict.deepStrictEqual(
      conflicted.diagnostics.map((item) => item.code),
      ["TSQ205"],
    );
    strict.strictEqual(conflicted.queries.length, 0);
    strict.throws(
      () => compileSource({ source: conditional, schema, dialect: diagnosticDialect, maxStructuralVariants: 0 }),
      /positive safe integer/,
    );
  });

  await it("injects an inferred row type without changing SQL text", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = 'import { sql } from "@typed-sql/postgres";\nconst q = sql`SELECT id FROM users`;';
    const result = compileSource({ source, schema: schema as PostgresSchemaSnapshot, dialect: postgres() });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.ok(result.transformedSource.includes('sql<{ "id": number; }, readonly []>`SELECT id FROM users`'));
    strict.match(result.queries[0]?.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
    strict.deepStrictEqual(result.queries[0]?.variantFingerprints, [result.queries[0]?.fingerprint]);
    strict.strictEqual(result.queries[0]?.semantics.operation.value, "read");
    strict.strictEqual(result.queries[0]?.semantics.dependencies[0]?.range.line, 2);
  });

  await it("merges structural semantic variants and fingerprints without source-path identity", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      "const q = sql`SELECT id FROM users ${filter ? sql.fragment`WHERE id = ${id}` : sql.empty}`;",
    ].join("\n");
    const first = compileSource({ source, schema: schema as PostgresSchemaSnapshot, dialect: postgres() });
    const second = compileSource({ source, schema: schema as PostgresSchemaSnapshot, dialect: postgres() });
    strict.deepStrictEqual(first.queries, second.queries);
    strict.strictEqual(first.queries[0]?.variantFingerprints.length, 2);
    strict.strictEqual(first.queries[0]?.semantics.operation.value, "read");
    strict.strictEqual(first.queries[0]?.semantics.volatility.value, "stable");
    strict.ok(first.queries[0]?.semantics.dependencies.every(({ range }) => range.line === 2));
  });

  await it("injects CTE and DML RETURNING rows and command-only never results", async () => {
    const schema = await loadSchemaSnapshot(schemaPath);
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      "const selected = sql`WITH chosen AS (SELECT id FROM users) SELECT id FROM chosen`;",
      "const inserted = sql`INSERT INTO users (name) VALUES (${name}) RETURNING id`;",
      "const deleted = sql`DELETE FROM users WHERE id = ${id}`;",
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

  await it("analyzes direct fragment map callbacks with a representative non-empty expansion", async () => {
    const schema = (await loadSchemaSnapshot(schemaPath)) as PostgresSchemaSnapshot;
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      'const rows: readonly { readonly id: number; readonly name: string }[] = [{ id: 1, name: "Ada" }];',
      "const inserted = sql`INSERT INTO users (id, name) VALUES ${rows.map(",
      "  (row) => sql.fragment`(${row.id}, ${row.name})`,",
      ")} RETURNING id, name`;",
    ].join("\n");
    const result = compileSource({ source, schema, dialect: postgres() });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.queries.length, 1);
    strict.strictEqual(
      result.queries[0]?.variants[0]?.sql,
      "INSERT INTO users (id, name) VALUES ($1, $2), ($3, $4) RETURNING id, name",
    );
    strict.strictEqual(result.queries[0]?.parameterType, "readonly unknown[]");
    const artifact = result.queries[0]?.repeatedFragments?.[0];
    strict.strictEqual(artifact?.kind, "repeated-fragment");
    strict.strictEqual(artifact?.minimumItems, 1);
    strict.strictEqual(artifact?.separator.text, ", ");
    strict.strictEqual(artifact?.element.sqlSkeleton, "({{parameter:1}}, {{parameter:2}})");
    strict.deepStrictEqual(
      artifact?.parameterPattern.map(({ index, tsType, nullable }) => ({ index, tsType, nullable })),
      [
        { index: 1, tsType: "number", nullable: false },
        { index: 2, tsType: "string", nullable: false },
      ],
    );
    strict.match(artifact?.fingerprint ?? "", /^sha256:[a-f\d]{64}$/u);
    strict.ok(result.transformedSource.includes("sql.__typedRow<"));
    strict.ok(result.transformedSource.includes("sql.fragment<readonly [number, string]>"));

    const directory = await mkdtemp(join(fixtureDirectory, ".typed-sql-fragment-list-"));
    try {
      const file = join(directory, "fragment-list.ts");
      await writeFile(
        file,
        [
          source,
          'import type { QueryParameters, QueryRow } from "@typed-sql/core";',
          "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
          "type Assert<T extends true> = T;",
          "const inferredRow: Assert<Equal<QueryRow<typeof inserted>, { id: number; name: string }>> = true;",
          "const inferredParameters: Assert<Equal<QueryParameters<typeof inserted>, readonly (number | string)[]>> = true;",
          "void inferredRow; void inferredParameters;",
        ].join("\n"),
      );
      const checked = await checkFile({
        file,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.strictEqual(checked.ok, true, checked.typeScript?.output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("analyzes fixed fragment array literals without treating value arrays as structure", async () => {
    const schema = (await loadSchemaSnapshot(schemaPath)) as PostgresSchemaSnapshot;
    const structural = [
      'import { sql } from "@typed-sql/postgres";',
      'const first = 1; const firstName = "Ada"; const second = 2; const secondName = "Grace";',
      "const inserted = sql`INSERT INTO users (id, name) VALUES ${[",
      "  sql.fragment`(${first}, ${firstName})`,",
      "  sql.fragment`(${second}, ${secondName})`,",
      "]} RETURNING id`;",
    ].join("\n");
    const result = compileSource({ source: structural, schema, dialect: postgres() });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(
      result.queries[0]?.variants[0]?.sql,
      "INSERT INTO users (id, name) VALUES ($1, $2), ($3, $4) RETURNING id",
    );
    strict.strictEqual(result.queries[0]?.parameterType, "readonly [number, string, number, string]");

    const ordinary = [
      'import { sql } from "@typed-sql/postgres";',
      "const ids = [1, 2, 3];",
      "const selected = sql`SELECT id FROM users WHERE id = ANY(${ids})`;",
    ].join("\n");
    const ordinaryResult = compileSource({ source: ordinary, schema, dialect: postgres() });
    strict.deepStrictEqual(ordinaryResult.diagnostics, []);
    strict.strictEqual(ordinaryResult.queries[0]?.variants[0]?.sql, "SELECT id FROM users WHERE id = ANY($1)");
  });

  await it("fails closed for unsupported fragment-list callback shapes", async () => {
    const schema = (await loadSchemaSnapshot(schemaPath)) as PostgresSchemaSnapshot;
    const expression = (body: string) =>
      [
        'import { sql } from "@typed-sql/postgres";',
        "const rows = [{ id: 1 }];",
        `const query = sql\`INSERT INTO users (id) VALUES \${${body}}\`;`,
      ].join("\n");
    for (const [body, code] of [
      ["[]", "TSQ008"],
      ["[sql.fragment`(1)`, 2]", "TSQ009"],
      ["[[sql.fragment`(1)`]]", "TSQ010"],
      ["rows.map(async (row) => sql.fragment`(${row.id})`)", "TSQ011"],
      ["rows.map((row) => row.id > 0 ? sql.fragment`(${row.id})` : sql.fragment`(${row.id}, 2)`)", "TSQ012"],
      ["rows.flatMap((row) => [sql.fragment`(${row.id})`])", "TSQ013"],
    ] as const) {
      const result = compileSource({ source: expression(body), schema, dialect: postgres() });
      strict.strictEqual(result.diagnostics[0]?.code, code, body);
      strict.strictEqual(result.queries.length, 0);
      strict.ok((result.diagnostics[0]?.range.start ?? 0) > 0);
    }
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
    strict.throws(
      () =>
        compileSource({
          source: 'import { sql } from "@typed-sql/postgres"; sql`SELECT id FROM users`;',
          schema: { ...schema, dialect: "mysql" } as PostgresSchemaSnapshot,
          dialect: postgres(),
        }),
      /cannot compile/,
    );
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
    strict.deepStrictEqual(
      result.sqlDiagnostics.map((diagnostic) => diagnostic.code),
      ["TSQ101", "TSQ105", "TSQ100"],
    );
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
    strict.strictEqual(result.analysis.identity.source.id.endsWith("query.ts"), true);
    strict.match(result.analysis.revision, /^sha256:[a-f0-9]{64}$/u);
    strict.strictEqual(result.typeScript?.exitCode, 0, result.typeScript?.output);
    strict.strictEqual(result.ok, true);
  });

  await it("rejects an interpolation whose TypeScript type does not match its SQL position", async () => {
    const directory = await mkdtemp(join(fixtureDirectory, ".typed-sql-params-"));
    try {
      const file = join(directory, "wrong-parameter.ts");
      await writeFile(
        file,
        [
          'import { sql } from "@typed-sql/postgres";',
          'const id = "not-a-number";',
          "export const query = sql`SELECT id FROM users WHERE id = ${id}`;",
        ].join("\n"),
      );
      const result = await checkFile({
        file,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.deepStrictEqual(result.sqlDiagnostics, []);
      strict.notStrictEqual(result.typeScript?.exitCode, 0, result.typeScript?.output);
      strict.ok(
        result.typeScript?.output.includes("not assignable to parameter of type 'number'"),
        result.typeScript?.output,
      );
      strict.ok(result.transformedSource.includes("readonly [number]>`SELECT"));
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
        "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
        "type Assert<T extends true> = T;",
        "const base = sql`SELECT id, name FROM users`;",
        "const appendBase = sql`SELECT id, name FROM users`;",
        "type User = QueryRow<typeof base>;",
        'type Filters = { readonly id?: User["id"] | null; readonly name?: User["name"] | null };',
        'function users(filters: Filters, mode: "all" | "any") {',
        "  const predicates = [",
        "    filters.id == null ? undefined : sql.fragment`users.id = ${filters.id}`,",
        "    filters.name == null ? undefined : sql.fragment`users.name = ${filters.name}`,",
        "  ] as const;",
        '  return sql.where(base, mode === "all" ? sql.and(predicates) : sql.or(predicates));',
        "}",
        "function users2(filters: Filters) {",
        "  return sql.append(",
        "    appendBase,",
        "    sql.fragment` WHERE 1 = 1`,",
        "    filters.id == null ? undefined : sql.fragment` AND users.id = ${filters.id}`,",
        "    filters.name == null ? undefined : sql.fragment` AND users.name = ${filters.name}`,",
        "  );",
        "}",
      ];
      await writeFile(
        validFile,
        [
          ...shared,
          'const query = users({ id: 1, name: "Ada" }, "all");',
          'const query2 = users2({ id: 1, name: "Ada" });',
          "const exact: Assert<Equal<QueryParameters<typeof query>, readonly [number, string]>> = true;",
          "const exact2: Assert<Equal<QueryParameters<typeof query2>, readonly [number, string]>> = true;",
          "void exact;",
          "void exact2;",
        ].join("\n"),
      );
      const valid = await checkFile({
        file: validFile,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.strictEqual(valid.ok, true, valid.typeScript?.output);
      strict.ok(valid.transformedSource.includes("sql.fragment<readonly [number]>` AND users.id"));
      strict.ok(valid.transformedSource.includes("sql.fragment<readonly [string]>` AND users.name"));

      const invalidFile = join(directory, "invalid-composed-filter.ts");
      await writeFile(
        invalidFile,
        [
          ...shared,
          'users({ id: "not-a-number" }, "all");',
          'sql.append(appendBase, sql.fragment` WHERE 1 = 1`, sql.fragment` AND users.id = ${"not-a-number"}`);',
        ].join("\n"),
      );
      const invalid = await checkFile({
        file: invalidFile,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.strictEqual(invalid.ok, false);
      strict.ok(invalid.typeScript?.output.includes("not assignable to type 'number'"), invalid.typeScript?.output);
      strict.ok(
        invalid.typeScript?.output.includes("not assignable to parameter of type 'number'"),
        invalid.typeScript?.output,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("preserves inferred rows and parameters through adapter prepared factories", async () => {
    const directory = await mkdtemp(join(fixtureDirectory, ".typed-sql-prepared-factory-"));
    try {
      const file = join(directory, "prepared-factory.ts");
      await writeFile(
        file,
        [
          'import { sql } from "@typed-sql/postgres";',
          'import type { QueryParameters, QueryRow } from "@typed-sql/core";',
          'import type { PostgresDatabase, PostgresPreparedQueryFactory } from "@typed-sql/postgres/runtime";',
          "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
          "type Assert<T extends true> = T;",
          "declare const database: PostgresDatabase;",
          'const byId = database.prepare("user-by-id", (id: number) =>',
          "  sql`SELECT users.id, users.name FROM users WHERE users.id = ${id}`",
          ");",
          "const query = byId(1);",
          "const row: Assert<Equal<QueryRow<typeof query>, { id: number; name: string }>> = true;",
          "const params: Assert<Equal<QueryParameters<typeof query>, readonly [number]>> = true;",
          "const factory: PostgresPreparedQueryFactory<",
          "  [id: number],",
          "  { id: number; name: string },",
          "  readonly [number]",
          "> = byId;",
          "void row; void params; void factory;",
        ].join("\n"),
      );

      const result = await checkFile({
        file,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.deepStrictEqual(result.sqlDiagnostics, []);
      strict.strictEqual(result.ok, true, result.typeScript?.output);
      strict.ok(result.transformedSource.includes("readonly [number]>`SELECT users.id"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("infers conditional structural SELECT fragments without replacing SQL with a builder", async () => {
    const directory = await mkdtemp(join(fixtureDirectory, ".typed-sql-structural-"));
    try {
      const file = join(directory, "conditional-select.ts");
      await writeFile(
        file,
        [
          'import { sql } from "@typed-sql/postgres";',
          'import type { QueryRow } from "@typed-sql/core";',
          "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
          "type Assert<T extends true> = T;",
          "interface Filters { readonly id?: number | null; readonly name: string }",
          "interface Selection { readonly name: boolean; readonly age: boolean }",
          "function users<const Select extends Selection>(filters: Filters, select: Select) {",
          "  return sql`",
          "    SELECT users.id",
          "      ${select.name ? sql.fragment`, users.name` : sql.empty}",
          "      ${select.age ? sql.fragment`, users.age` : sql.empty}",
          "    FROM users",
          "    WHERE users.name = ${filters.name}",
          "      ${filters.id == null ? sql.empty : sql.fragment`AND users.id >= ${filters.id}`}",
          "  `;",
          "}",
          'const basic = users({ name: "Ada" }, { name: false, age: false });',
          'const named = users({ name: "Ada" }, { name: true, age: false });',
          'const aged = users({ name: "Ada" }, { name: false, age: true });',
          'const detailed = users({ name: "Ada" }, { name: true, age: true });',
          "const basicRow: Assert<Equal<QueryRow<typeof basic>, { id: number }>> = true;",
          "const namedRow: Assert<Equal<QueryRow<typeof named>, { id: number; name: string }>> = true;",
          "const agedRow: Assert<Equal<QueryRow<typeof aged>, { id: number; age: number | null }>> = true;",
          "const detailedRow: Assert<Equal<QueryRow<typeof detailed>, { id: number; name: string; age: number | null }>> = true;",
          "void basicRow; void namedRow; void agedRow; void detailedRow;",
        ].join("\n"),
      );
      const result = await checkFile({
        file,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.deepStrictEqual(result.sqlDiagnostics, []);
      strict.strictEqual(result.ok, true, result.typeScript?.output);
      strict.ok(result.transformedSource.includes('sql.__typed<Select["name"] extends true'));
      strict.ok(result.transformedSource.includes("sql.fragment<readonly [number]>`AND users.id"));

      const invalidFile = join(directory, "invalid-structural-parameter.ts");
      await writeFile(
        invalidFile,
        [
          'import { sql } from "@typed-sql/postgres";',
          "interface Selection { readonly age: boolean }",
          "function users<const Select extends Selection>(select: Select) {",
          '  return sql`SELECT users.id${select.age ? sql.fragment`, users.age` : sql.empty} FROM users WHERE users.id = ${"wrong"}`;',
          "}",
        ].join("\n"),
      );
      const invalid = await checkFile({
        file: invalidFile,
        schema: schemaPath,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.strictEqual(invalid.ok, false);
      strict.ok(
        invalid.typeScript?.output.includes("not assignable to parameter of type 'never'"),
        invalid.typeScript?.output,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("discovers tsconfig, accepts in-memory schemas, and reports TypeScript failures", async () => {
    const schema = (await loadSchemaSnapshot(schemaPath)) as PostgresSchemaSnapshot;
    const discovered = await checkFile({
      file: resolve(fixtureDirectory, "query.ts"),
      schema,
      dialect: postgres(),
    });
    strict.strictEqual(discovered.ok, true, discovered.typeScript?.output);
    await strict.rejects(
      () =>
        checkFile({
          file: resolve(fixtureDirectory, "query.ts"),
          schema,
          project: resolve(fixtureDirectory, "tsconfig.json"),
          dialect: postgres(),
          typeScriptTimeoutMs: 0,
        }),
      /typeScriptTimeoutMs must be a positive safe integer/,
    );

    const directory = await mkdtemp(join(tmpdir(), "typed-sql-compiler-"));
    try {
      const file = join(directory, "invalid.ts");
      await writeFile(
        file,
        'import { sql } from "@typed-sql/postgres";\nconst query = sql`SELECT id FROM users`;\nconst invalid: number = "text";\n',
      );
      const invalid = await checkFile({
        file,
        schema,
        dialect: postgres(),
        project: resolve(fixtureDirectory, "tsconfig.json"),
      });
      strict.strictEqual(invalid.ok, false);
      strict.ok((invalid.typeScript?.output.length ?? 0) > 0);
      await strict.rejects(() => checkFile({ file, schema, dialect: postgres() }), /Could not find tsconfig/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("rejects an untested TypeScript patch before writing native-check overlays", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-compiler-version-"));
    try {
      const binDirectory = join(directory, "node_modules", ".bin");
      await mkdir(binDirectory, { recursive: true });
      const binary = join(binDirectory, process.platform === "win32" ? "tsc.cmd" : "tsc");
      await writeFile(
        binary,
        process.platform === "win32" ? "@echo Version 7.0.3\r\n" : "#!/bin/sh\nprintf 'Version 7.0.3\\n'\n",
      );
      if (process.platform !== "win32") await chmod(binary, 0o755);
      const file = join(directory, "query.ts");
      const project = join(directory, "tsconfig.json");
      await writeFile(file, 'import { sql } from "@typed-sql/postgres"; const query = sql`SELECT id FROM users`;\n');
      await writeFile(project, `${JSON.stringify({ compilerOptions: { strict: true }, files: ["query.ts"] })}\n`);
      const schema = (await loadSchemaSnapshot(schemaPath)) as PostgresSchemaSnapshot;
      await strict.rejects(
        () => checkFile({ file, project, schema, dialect: postgres() }),
        /requires TypeScript 7\.0\.2[\s\S]*found 7\.0\.3/u,
      );
      strict.deepStrictEqual(
        (await readdir(directory)).filter((name) => name.startsWith(".typed-sql-")),
        [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
