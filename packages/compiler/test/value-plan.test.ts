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
  await it("retains unknown parameter slots when grammar evidence is sparse", () => {
    const result = buildQueryValuePlan(
      postgres(),
      { columns: [], parameters: [{ index: 2, tsType: "number", nullable: false, databaseType: "integer" }] },
      undefined,
      3,
    );
    strict.deepEqual(result.parameters, [
      { index: 1, type: "unknown", nullable: true },
      { index: 2, type: "number", nullable: false },
      { index: 3, type: "unknown", nullable: true },
    ]);
    strict.throws(
      () =>
        buildQueryValuePlan(
          postgres(),
          { columns: [], parameters: [{ index: 2, tsType: "number", nullable: false }] },
          undefined,
          1,
        ),
      TypeError,
    );
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
    const { runtimeSqlModule: _portable, ...dialect } = postgres();
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
  await it("executes compiled conditional choices and dynamic cardinalities with isolated parameters", async () => {
    const schema = (await loadSchemaSnapshot(
      resolve(root, "test/fixtures/success/schema.json"),
    )) as PostgresSchemaSnapshot;
    const source = [
      'import { sql } from "@typed-sql/postgres";',
      'import { getQueryValuePlan, renderQuery, encodeQueryValues } from "@typed-sql/core";',
      'import { renderer } from "@typed-sql/postgres/query";',
      "let choices=0;const choose=(value:boolean)=>{choices++;return value;};",
      "function conditional(flag:boolean,id:number){return sql`SELECT id${choose(flag)?sql.fragment`, name`:sql.empty} FROM users WHERE id=${id}`;}",
      "function repeated(prefix:number,ids:readonly number[],suffix:number){return sql`SELECT id FROM users WHERE id>=${prefix} AND id IN (${ids.map(id=>sql.fragment`${id}`)}) AND id<=${suffix}`;}",
      "function mixed(prefix:number,suffix:number,ids:readonly number[]){return sql`SELECT id FROM users WHERE id IN (${[sql.fragment`${prefix}`,sql.fragment`${suffix}`]}) OR id IN (${ids.map(id=>sql.fragment`${id}`)})`;}",
      "const a=conditional(true,1),b=conditional(false,2),c=conditional(true,3);",
      "const x=repeated(0,[1],9),y=repeated(2,[3,4,5],8),z=repeated(6,[7],10);",
      'process.stdout.write(JSON.stringify({choices,columns:[a,b].map(q=>getQueryValuePlan(q)?.columns.map(c=>c.name)),same:getQueryValuePlan(a)===getQueryValuePlan(c),parameters:[x,y,z].map(q=>encodeQueryValues(q,renderQuery(q,renderer).values,{id:"pg",dialect:"postgres",integer:"lossless",jsonWire:"parsed"})),counts:[x,y,z].map(q=>getQueryValuePlan(q)?.parameters.length),mixed:renderQuery(mixed(0,9,[1,2,3]),renderer).values}));',
    ].join("\r\n");
    const result = compileSource({ source, schema, dialect: postgres(), runtimeMetadata: true });
    strict.deepEqual(result.diagnostics, []);
    strict.equal(result.queries.length, 3);
    const repeated = result.queries.find((item) => item.repeatedFragments !== undefined)!;
    strict.equal(repeated.repeatedFragments?.[0]?.element.sqlSkeleton, "{{parameter:1}}");
    const directory = await mkdtemp(resolve(root, "node_modules/.selected-plans-"));
    try {
      const file = resolve(directory, "query.ts");
      await writeFile(file, result.transformedSource);
      const output = JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", file], { cwd: root, encoding: "utf8" }),
      );
      strict.deepEqual(output, {
        choices: 3,
        columns: [["id", "name"], ["id"]],
        same: true,
        parameters: [
          [0, 1, 9],
          [2, 3, 4, 5, 8],
          [6, 7, 10],
        ],
        counts: [3, 5, 3],
        mixed: [0, 9, 1, 2, 3],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("verifies composed SQL and preserves callback evaluation and parameter isolation", async () => {
    const schema = (await loadSchemaSnapshot(
      resolve(root, "test/fixtures/success/schema.json"),
    )) as PostgresSchemaSnapshot;
    const source = [
      'import {sql} from "@typed-sql/postgres";',
      'import {getQueryValuePlan,renderQuery} from "@typed-sql/core";',
      'import {renderer} from "@typed-sql/postgres/query";',
      "let calls=0;",
      "function make(id:number,flag:boolean){const base=sql`SELECT id FROM users`;return sql.append(base, (++calls,flag)?sql.fragment` WHERE id=${id}`:undefined);}",
      "function filtered(id:number){const base=sql`SELECT id FROM users`;return sql.where(base,sql.fragment`id=${id}`);}",
      "const queries=[make(1,true),make(2,false),filtered(3),make(4,true)];",
      "process.stdout.write(JSON.stringify({calls,values:queries.map(q=>renderQuery(q,renderer).values),counts:queries.map(q=>getQueryValuePlan(q)?.parameters.length)}));",
    ].join("\n");
    const result = compileSource({ source, schema, dialect: postgres(), runtimeMetadata: true });
    strict.deepEqual(result.diagnostics, []);
    const directory = await mkdtemp(resolve(root, "node_modules/.composed-plans-"));
    try {
      const file = resolve(directory, "query.ts");
      await writeFile(file, result.transformedSource);
      strict.deepEqual(
        JSON.parse(execFileSync(process.execPath, ["--import", "tsx", file], { cwd: root, encoding: "utf8" })),
        { calls: 3, values: [[1], [], [3], [4]], counts: [1, 0, 1, 1] },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const incompatible =
      'import {sql} from "@typed-sql/postgres";const base=sql`UPDATE users SET name=${"next"}`;const q=sql.append(base,sql.fragment` RETURNING id`);';
    for (const runtimeMetadata of [false, true])
      strict.ok(
        compileSource({ source: incompatible, schema, dialect: postgres(), runtimeMetadata }).diagnostics.some(
          (item) => item.code === "TSQ016",
        ),
      );
  });

  await it("does not infer a fixed representative JSON tuple for a dynamic repeated list in any mode", () => {
    for (const projection of [
      "jsonb_build_array(${items.map(item=>sql.fragment`${item}::int`)})",
      "jsonb_build_array(${items.map(item=>sql.fragment`${item}::int`)}) ->> 2",
    ]) {
      const source = `import {sql} from "@typed-sql/postgres";const q=sql\`SELECT ${projection} AS value\`;`;
      const schema = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
      for (const runtimeMetadata of [false, true]) {
        const result = compileSource({ source, schema, dialect: postgres(), runtimeMetadata });
        strict.deepEqual(result.diagnostics, []);
        strict.equal(result.queries[0]?.rowType, '{ "value": unknown | null; }');
        if (runtimeMetadata && projection.endsWith("})"))
          strict.equal(result.queries[0]?.valuePlanChoices?.[0]?.plan.columns[0]?.json?.shape.kind, "unknown");
      }
    }
  });
});
