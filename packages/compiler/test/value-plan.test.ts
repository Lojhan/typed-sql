import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it, strict } from "poku";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { calculateTypePolicyHash, loadSchemaSnapshot } from "../../schema/src/index.js";
import { buildQueryManifest, buildQueryValuePlan, compileSource } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
await describe("executable compiler value metadata", async () => {
  await it("emits a plan that survives TypeScript erasure and query construction", async () => {
    const schema = (await loadSchemaSnapshot(
      resolve(root, "test/fixtures/success/schema.json"),
    )) as PostgresSchemaSnapshot;
    const base = postgres();
    const dialect = { ...base, runtimeValueType: () => "number" as const };
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      'import { getQueryValuePlan } from "@typed-sql/core";',
      "const query = sql`SELECT id FROM users WHERE id = ${1}`;",
      "process.stdout.write(JSON.stringify(getQueryValuePlan(query)));",
    ].join("\n");
    const compiled = compileSource({ source, schema, dialect, runtimeMetadata: true });
    strict.deepEqual(compiled.diagnostics, []);
    const directory = await mkdtemp(resolve(root, "node_modules/.value-plan-"));
    try {
      const file = resolve(directory, "query.ts");
      await writeFile(file, compiled.transformedSource);
      const plan = JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", file], { cwd: root, encoding: "utf8" }),
      );
      strict.deepEqual(plan, compiled.queries[0]?.valuePlan);
      strict.equal(plan.dialect, "postgres");
      strict.equal(plan.typePolicyHash, calculateTypePolicyHash(base.defaultTypePolicy));
      strict.deepEqual(plan.columns, [{ type: "number", nullable: false, name: "id" }]);
      strict.deepEqual(plan.parameters, [{ type: "number", nullable: false, index: 1 }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("preserves explicit JSON descriptors and recognizes portable grammar imports", async () => {
    const base = postgres();
    const valuePlan = buildQueryValuePlan(base, {
      columns: [
        {
          name: "payload",
          tsType: "string",
          nullable: false,
          range: { start: 0, end: 1, line: 1, column: 1 },
          json: {
            shape: { kind: "object", properties: { id: { shape: { kind: "number" } } } },
            representation: "text",
          },
        },
      ],
      parameters: [],
    });
    strict.equal(valuePlan.columns[0]?.json?.representation, "text");
    strict.deepEqual(valuePlan.columns[0]?.json?.shape, {
      kind: "object",
      properties: { id: { shape: { kind: "number" } } },
    });
    const schema = (await loadSchemaSnapshot(
      resolve(root, "test/fixtures/success/schema.json"),
    )) as PostgresSchemaSnapshot;
    const compiled = compileSource({
      source: 'import { sql } from "@example/portable-query"; const q = sql`SELECT id FROM users`;',
      schema,
      dialect: { ...base, runtimeSqlModule: "@example/portable-query" },
      runtimeMetadata: true,
    });
    strict.deepEqual(compiled.diagnostics, []);
    strict.equal(compiled.queries.length, 1);
    strict.equal(compiled.queries[0]?.valuePlan?.dialect, "postgres");
  });
  await it("includes portable static and dynamic queries in manifest coverage", async () => {
    const base = postgres();
    const schema = (await loadSchemaSnapshot(
      resolve(root, "test/fixtures/success/schema.json"),
    )) as PostgresSchemaSnapshot;
    const source =
      'import {sql} from "@example/portable-query"; const known=sql`SELECT id FROM users`; const dynamic=sql.dynamic("SELECT 1");';
    const result = buildQueryManifest({
      rootDir: root,
      sources: [{ file: resolve(root, "app.ts"), source }],
      projects: [],
      dialect: { ...base, runtimeSqlModule: "@example/portable-query" },
      schema,
      compilerVersion: "test",
    });
    strict.equal(result.stats.resolvedQueries, 1);
    strict.equal(result.stats.unresolvedQueries, 1);
    strict.ok(result.manifest.queries.some((query) => query.status === "unresolved" && query.reason === "dynamic"));
  });
  await it("rejects metadata transforms that would narrow application declarations without an executable plan", () => {
    const dialect = postgres();
    const schema = {
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        accounts: {
          name: "accounts",
          columns: {
            document: {
              name: "document",
              databaseType: "jsonb",
              tsType: "unknown",
              nullable: false,
              jsonDeclaration: {
                source: "application",
                shape: { kind: "object", properties: { id: { shape: { kind: "number" } } } },
              },
            },
          },
        },
      },
    } as const;
    const source =
      'import { sql } from "@typed-sql/postgres"; const query = sql`SELECT document FROM accounts ${condition ? sql.fragment`WHERE true` : sql.empty}`;';
    const result = compileSource({ source, dialect, schema, runtimeMetadata: true });
    strict.deepEqual(
      result.diagnostics.map((item) => item.code),
      ["TSQ016"],
    );
    strict.equal(result.queries.length, 0);
    strict.ok(!result.transformedSource.includes(".__typed"));
    const ide = compileSource({ source, dialect, schema });
    strict.deepEqual(ide.diagnostics, []);
    strict.equal(ide.queries[0]?.rowType, '{ "document": unknown; }');
  });
  await it("reuses module plans without changing directives, tag identity, argument evaluation, or values", async () => {
    const schema = (await loadSchemaSnapshot(
      resolve(root, "test/fixtures/success/schema.json"),
    )) as PostgresSchemaSnapshot;
    const prefix = '#!/usr/bin/env node\n"use client"\n/* module header */\n"use strict";';
    const source =
      prefix +
      "\n" +
      [
        'const __typedSqlRuntime0 = "application binding";',
        "let evaluations = 0;",
        "function make(value: number) { return tag`SELECT id FROM users WHERE id = ${(evaluations++, value)}`; }",
        "const first = make(1); const second = make(2);",
        "process.stdout.write(JSON.stringify({samePlan:getQueryValuePlan(first) === getQueryValuePlan(second), sameText:first.segments[0] === second.segments[0], evaluations, first:renderQuery(first, postgresRenderer).values, second:renderQuery(second, postgresRenderer).values, applicationBinding:__typedSqlRuntime0}));",
        'import { sql as tag } from "@typed-sql/postgres";',
        'import { postgresRenderer } from "@typed-sql/postgres/query";',
        'import { getQueryValuePlan, renderQuery } from "@typed-sql/core";',
      ].join("\n");
    const result = compileSource({ source, schema, dialect: postgres(), runtimeMetadata: true });
    strict.deepEqual(result.diagnostics, []);
    strict.ok(result.transformedSource.startsWith(prefix));
    const directory = await mkdtemp(resolve(root, "node_modules/.hoisted-plans-"));
    try {
      const file = resolve(directory, "query.ts");
      await writeFile(file, result.transformedSource);
      const output = JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", file], { cwd: root, encoding: "utf8" }),
      );
      strict.deepEqual(output, {
        samePlan: true,
        sameText: true,
        evaluations: 2,
        first: [1],
        second: [2],
        applicationBinding: "application binding",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    for (const statement of [
      "++globalThis.counter;",
      "--globalThis.counter;",
      "!globalThis.counter;",
      "const value = 1;",
    ]) {
      const directiveSource = [
        '"use client"',
        statement,
        'import { sql } from "@typed-sql/postgres";',
        "const query = sql`SELECT id FROM users`;",
      ].join("\n");
      const directiveResult = compileSource({
        source: directiveSource,
        schema,
        dialect: postgres(),
        runtimeMetadata: true,
      });
      strict.ok(directiveResult.transformedSource.startsWith('"use client"'));
    }
    const invalid = `${source}\nconst invalid = tag\`SELECT missing_column FROM users\`;`;
    const failure = compileSource({ source: invalid, schema, dialect: postgres(), runtimeMetadata: true });
    const diagnostic = failure.diagnostics.find((item) => item.code === "TSQ101");
    strict.ok(diagnostic);
    strict.equal(invalid.slice(diagnostic!.range.start, diagnostic!.range.end), "missing_column");
  });
});
