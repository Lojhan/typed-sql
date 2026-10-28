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
});
