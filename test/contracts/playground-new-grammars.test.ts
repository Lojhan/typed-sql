import { describe, it, strict } from "poku";
import { ENVIRONMENT_FILE, environmentSource } from "../../website/.vitepress/theme/playground/environment-model.js";
import { nativeCommerceFiles } from "../../website/.vitepress/theme/playground/native-commerce-example.js";
import { DEFAULT_SCHEMAS, parsePlaygroundSchema } from "../../website/.vitepress/theme/playground/playground.js";
import { workspaceEnvironment } from "../../website/.vitepress/theme/playground/workspace-environment.js";
import {
  defaultPlaygroundState,
  restorePlaygroundState,
} from "../../website/.vitepress/theme/playground/workspace-storage.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("native SQL Server and DuckDB playgrounds", async () => {
  const service = createTestWorkspace();
  try {
    for (const dialect of ["sqlserver", "duckdb"] as const) {
      await it(`${dialect} opens a checked native commerce workspace and reports original-source errors`, () => {
        const files = nativeCommerceFiles(dialect);
        const result = service.analyze(dialect, files);
        strict.deepEqual(result.problems, []);
        strict.equal(result.queries.length, 9);
        for (const query of result.queries) {
          strict.doesNotMatch(query.rowType, /\bany\b/u);
          strict.doesNotMatch(query.parameterType, /\bany\b/u);
        }
        strict.ok(result.hovers["app.ts"]!.some((hover) => hover.content.includes("bigint")));
        const broken = { ...files, "app.ts": files["app.ts"].replace("accountById(42n)", 'accountById("42")') };
        const invalid = service
          .analyze(dialect, broken)
          .problems.find((problem) => problem.file === "app.ts" && problem.code === "TS2345");
        strict.ok(invalid);
        strict.ok(broken["app.ts"].slice(invalid!.from, invalid!.to).includes('"42"'));
      });
      await it(`${dialect} completes inferred row members through the editor worker`, () => {
        const files = nativeCommerceFiles(dialect);
        files["app.ts"] += "\nconst first = null as unknown as Account; first.";
        service.analyze(dialect, files);
        const entries = service.interact({
          kind: "completions",
          file: "app.ts",
          position: files["app.ts"].length,
        }) as readonly { name: string }[];
        strict.ok(entries.some(({ name }) => name === "email"));
        strict.ok(entries.some(({ name }) => name === "id"));
      });
      await it(`${dialect} restores custom work without changing existing three-grammar saves`, () => {
        const old = {
          version: 2,
          dialect: "postgres",
          workspaces: { postgres: { files: { "app.ts": "export const own = 1;" }, example: "custom" } },
        };
        const restored = restorePlaygroundState(old);
        strict.deepEqual(restored.workspaces.postgres.files, old.workspaces.postgres.files);
        strict.deepEqual(restored.workspaces[dialect].files, defaultPlaygroundState().workspaces[dialect].files);
        const files = { ...restored.workspaces[dialect].files, "notes.ts": "export const own = 1;" };
        const custom = restorePlaygroundState({
          version: 2,
          dialect,
          workspaces: { [dialect]: { files, example: "commerce" } },
        });
        strict.equal(custom.dialect, dialect);
        strict.equal(custom.workspaces[dialect].example, "custom");
        strict.deepEqual(custom.workspaces[dialect].files, files);
      });
    }
    await it("shows exact native nested shapes, independent NULLs and finite ARRAY length", () => {
      const result = service.analyze("duckdb", nativeCommerceFiles("duckdb"));
      const row = result.queries.find((query) => query.binding === "productAnalytics")!.rowType;
      for (const fragment of [
        'readonly "weight": string | null',
        'readonly "tags": readonly (string | null)[] | null',
        "readonly [string, string | null]",
        "readonly [number | null, number | null, number | null]",
        'readonly tag: "warehouse"',
        "readonly value: number | null",
        '"rank": bigint',
      ])
        strict.ok(row.includes(fragment), fragment);
      strict.match(
        result.queries.find((query) => query.binding === "orderDocument")!.rowType,
        /readonly "customer": \{ readonly "email": string \| null/u,
      );
      const sqlserver = service.analyze("sqlserver", nativeCommerceFiles("sqlserver"));
      strict.equal(
        sqlserver.queries.find((query) => query.binding === "topProducts")!.rowType,
        '{ "id": bigint; "sku": string; "weight": string | null; }',
      );
      strict.ok(sqlserver.queries.find((query) => query.binding === "insertPair")!.sql.includes("OUTPUT inserted"));
    });
    await it("uses SQL Server collation evidence and DuckDB ASCII folding for schema identities", () => {
      const tables = "CREATE TABLE Users(id bigint); CREATE TABLE users(id bigint);";
      const sensitive = parsePlaygroundSchema("sqlserver", tables, false, {
        settings: { collation: "Latin1_General_100_CS_AS" },
      });
      strict.deepEqual(sensitive.diagnostics, []);
      strict.ok(parsePlaygroundSchema("sqlserver", tables).diagnostics.some((problem) => problem.code === "PLAY207"));
      strict.ok(parsePlaygroundSchema("duckdb", tables).diagnostics.some((problem) => problem.code === "PLAY207"));
      const unicode = parsePlaygroundSchema("duckdb", 'CREATE TABLE "Å"(id BIGINT); CREATE TABLE "å"(id BIGINT);');
      strict.deepEqual(unicode.diagnostics, []);
      const multipart = service.analyze("duckdb", {
        "schema/tables.sql":
          "CREATE TABLE a.main.users(id BIGINT NOT NULL); CREATE TABLE b.main.users(id VARCHAR NOT NULL);",
        "query.sql": "SELECT id FROM a.main.users;",
      });
      strict.deepEqual(multipart.problems, []);
      strict.equal(multipart.queries[0]!.rowType, '{ "id": bigint; }');
    });
    await it("contains invalid native type errors in schema diagnostics and preserves PostgreSQL folding", () => {
      for (const source of ["CREATE TABLE broken (id STRUCT(a));", "CREATE TABLE broken (id DECIMAL(3, 9));"]) {
        const result = parsePlaygroundSchema("duckdb", source);
        strict.ok(result.diagnostics.some(({ code }) => code === "PLAY006"));
        strict.equal(result.snapshot, undefined);
      }
      const result = parsePlaygroundSchema(
        "postgres",
        'CREATE TABLE PUBLIC.Users (ID bigint); CREATE TABLE "Users" ("ID" bigint);',
      );
      strict.deepEqual(result.diagnostics, []);
      strict.equal(result.snapshot!.relations["public.users"]!.columns.id!.name, "id");
      strict.equal(result.snapshot!.relations.Users!.columns.ID!.name, "ID");
    });
    await it("never executes settings expressions and does not guess support for unknown engines", () => {
      strict.deepEqual(
        workspaceEnvironment({
          [ENVIRONMENT_FILE]: environmentSource({ version: "1.5.6", settings: { TimeZone: "UTC" } }),
        }),
        { version: "1.5.6", settings: { TimeZone: "UTC" } },
      );
      for (const value of [
        "process.env.VERSION",
        "{ ...external }",
        "{ version: getVersion() }",
        '{ version: "2.0.0", settings: { TimeZone: (() => "UTC")() } }',
        '{ version: "2.0.0", version: "1.5.6" }',
      ]) {
        const files = {
          "schema/tables.sql": DEFAULT_SCHEMAS.duckdb,
          [ENVIRONMENT_FILE]: `export const environment = ${value};`,
          "query.sql": "SELECT id FROM users;",
        };
        const result = service.analyze("duckdb", files);
        strict.equal(result.queries.length, 0);
        strict.ok(result.problems.some((problem) => problem.code === "PLAY209" && problem.file === ENVIRONMENT_FILE));
      }
      const unknown = service.analyze("duckdb", {
        "schema/tables.sql": DEFAULT_SCHEMAS.duckdb,
        [ENVIRONMENT_FILE]: environmentSource({ version: "2.1.0" }),
        "query.sql": "SELECT id FROM users;",
      });
      strict.ok(unknown.problems.some((problem) => problem.code === "TSQ402"));
      strict.ok(!unknown.queries.some((query) => query.rowType.includes('"id": bigint')));
    });
    await it("preserves bracket identifiers and astral source positions in T-SQL files", () => {
      const source = "-- 😀\nSELECT missing FROM [sales].[Order;History] WHERE [id] = @id;";
      const result = service.analyze("sqlserver", {
        "schema/tables.sql": "CREATE TABLE [sales].[Order;History]([id] bigint NOT NULL);",
        "query.sql": source,
      });
      const problem = result.problems.find((problem) => problem.code === "TSQ101");
      strict.ok(problem);
      strict.equal(source.slice(problem!.from, problem!.to), "missing");
      strict.equal(problem!.line, 2);
    });
  } finally {
    service.dispose();
  }
});
