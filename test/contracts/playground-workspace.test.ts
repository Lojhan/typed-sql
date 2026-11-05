import { describe, it, strict } from "poku";
import { DEFAULT_SCHEMAS, PLAYGROUND_DIALECTS } from "../../website/.vitepress/theme/playground/playground.js";
import {
  filePathError,
  lessonFiles,
  validWorkspaceFiles,
} from "../../website/.vitepress/theme/playground/workspace.js";
import { splitSql } from "../../website/.vitepress/theme/playground/workspace-sql.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("playground TypeScript workspace", async () => {
  const workspace = createTestWorkspace();
  try {
    for (const dialect of PLAYGROUND_DIALECTS) {
      await it(`carries ${dialect} contracts through an import and adapter results`, () => {
        const files = lessonFiles(dialect, "basics", DEFAULT_SCHEMAS[dialect]);
        const result = workspace.analyze(dialect, files);
        strict.deepStrictEqual(result.problems, []);
        strict.match(result.queries[0]!.rowType, /"id": bigint/u);
        strict.strictEqual(
          result.queries[0]!.parameterType,
          dialect === "sqlserver" ? "readonly [bigint | null]" : "readonly [bigint]",
        );
        const hovers = result.hovers["app.ts"]!;
        const imported = hovers.find(({ from }) => from === files["app.ts"].indexOf("accountById"));
        strict.match(imported!.content, /bigint/u);
        strict.match(imported!.content, /email/u);
        const rows = hovers.find(({ from }) => from === files["app.ts"].indexOf("rows"));
        strict.match(rows!.content, /readonly/u);
        strict.match(rows!.content, /email/u);
        strict.ok(result.hovers["queries/account.ts"]!.some(({ content }) => content.includes("SqlTag")));
      });
    }
    await it("reports a wrong argument at its original position across imports", () => {
      const files = lessonFiles("postgres", "errors", DEFAULT_SCHEMAS.postgres);
      const result = workspace.analyze("postgres", files);
      const problem = result.problems.find(({ file }) => file === "app.ts");
      strict.ok(problem);
      strict.match(problem!.message, /string.*bigint/u);
      strict.strictEqual(files["app.ts"].slice(problem!.from, problem!.to), '"42"');
    });
    await it("checks interpolations and maps diagnostics past the invisible type overlay", () => {
      const files = lessonFiles("postgres", "basics", DEFAULT_SCHEMAS.postgres);
      files["queries/account.ts"] = files["queries/account.ts"].replace("id: bigint", "id: string");
      files["app.ts"] = files["app.ts"].replace("42n", '"42"');
      const result = workspace.analyze("postgres", files);
      const problem = result.problems.find(({ file }) => file === "queries/account.ts");
      strict.ok(problem);
      strict.match(problem!.message, /string.*bigint/u);
      strict.strictEqual(files["queries/account.ts"].slice(problem!.from, problem!.to), "id");
    });
    await it("updates downstream types after schema edits and never retains a stale contract", () => {
      const files = lessonFiles("postgres", "joins", DEFAULT_SCHEMAS.postgres);
      const joined = workspace.analyze("postgres", files);
      strict.deepStrictEqual(joined.problems, []);
      strict.match(joined.queries[0]!.rowType, /"team_name": string \| null/u);
      files["schema/tables.sql"] = files["schema/tables.sql"].replaceAll("email text", "renamed_email text");
      const invalid = workspace.analyze("postgres", files);
      strict.strictEqual(invalid.queries.length, 0);
      strict.ok(invalid.problems.length > 0);
      const queryHover = invalid.hovers["app.ts"]!.find(({ from }) => from === files["app.ts"].indexOf("query ="));
      strict.match(queryHover!.content, /unknown/u);
    });
    await it("keeps dynamic query results unknown", () => {
      const result = workspace.analyze("postgres", lessonFiles("postgres", "unknown", DEFAULT_SCHEMAS.postgres));
      strict.strictEqual(result.queries.length, 0);
      strict.ok(result.problems.some(({ code }) => code === "PLAY102"));
      strict.ok(result.hovers["app.ts"]!.some(({ content }) => content.includes("Query<unknown")));
    });
    for (const dialect of PLAYGROUND_DIALECTS) {
      await it(`imports SQL queries and shares schema/function files in ${dialect}`, () => {
        const files = lessonFiles(dialect, "workspace", DEFAULT_SCHEMAS[dialect]);
        const result = workspace.analyze(dialect, files);
        strict.deepStrictEqual(result.problems, []);
        const imported = result.hovers["app.ts"]!.find(({ from }) => from === files["app.ts"].indexOf("sqlQuery ="));
        strict.match(imported!.content, /id: bigint/u);
        strict.match(imported!.content, /email: string/u);
        const standalone = result.queries.find(({ file }) => file === "queries/account.sql")!;
        strict.strictEqual(
          standalone.parameterType,
          dialect === "sqlserver" ? "readonly [bigint | null]" : "readonly [bigint]",
        );
        const summary = result.queries.find(({ file }) => file === "queries/summary.ts")!;
        strict.match(summary.rowType, /"label": string/u);
        if (dialect === "postgres" || dialect === "mysql") strict.match(summary.rowType, /string \| null/u);
        files["app.ts"] = files["app.ts"].replace("42n", '"42"');
        const invalid = workspace.analyze(dialect, files);
        strict.ok(invalid.problems.some(({ file, message }) => file === "app.ts" && /string.*bigint/u.test(message)));
      });
    }
    await it("resolves queries and ordinary functions through nested TypeScript modules", () => {
      const files = {
        ...lessonFiles("postgres", "basics", DEFAULT_SCHEMAS.postgres),
        "src/queries/account.ts":
          'import { sql } from "@typed-sql/postgres"; export function getAccount(id: bigint) { return sql`SELECT id, email FROM users WHERE id = ${id}`; }',
        "src/helpers.ts":
          'import { getAccount } from "./queries/account.js"; export const byId = (id: bigint) => getAccount(id);',
        "src/main.ts": 'import { byId } from "./helpers"; const result = byId(1n);',
      };
      const result = workspace.analyze("postgres", files);
      strict.deepStrictEqual(result.problems, []);
      strict.ok(result.hovers["src/main.ts"]!.some(({ content }) => /Query<.*email/su.test(content)));
      files["src/queries/account.ts"] = files["src/queries/account.ts"].replace("id, email", "id, display_name");
      const updated = workspace.analyze("postgres", files);
      const hover = updated.hovers["src/main.ts"]!.find(
        ({ from }) => from === files["src/main.ts"].indexOf("result ="),
      );
      strict.match(hover!.content, /display_name: string/u);
      strict.ok(!hover!.content.includes("email"));
    });
    await it("supports named SQL queries and diagnoses errors in the original SQL file", () => {
      const files = {
        ...lessonFiles("postgres", "basics", DEFAULT_SCHEMAS.postgres),
        "sql/accounts.sql":
          "-- name: emails\nSELECT id, email FROM users;\n\n-- name: byId\nSELECT id FROM users WHERE id = $1;",
        "src/main.ts":
          'import { byId, emails } from "../sql/accounts.sql"; const one = byId(1n); const all = emails();',
      };
      strict.deepStrictEqual(workspace.analyze("postgres", files).problems, []);
      files["sql/accounts.sql"] = files["sql/accounts.sql"].replace("SELECT id FROM", "SELECT missing_column FROM");
      const invalid = workspace.analyze("postgres", files);
      const problem = invalid.problems.find(({ file }) => file === "sql/accounts.sql")!;
      strict.ok(problem.line >= 5);
      strict.ok(files["sql/accounts.sql"].slice(problem.from, problem.to).includes("missing_column"));
      const hover = invalid.hovers["src/main.ts"]!.find(({ from }) => from === files["src/main.ts"].indexOf("one ="));
      strict.match(hover!.content, /unknown/u);
    });
    await it("maps shared schema problems to their file and drops every dependent contract", () => {
      const files = {
        ...lessonFiles("postgres", "basics", DEFAULT_SCHEMAS.postgres),
        "schema/extra.sql": "CREATE TABLE extra (id bigint, id text);",
        "query.sql": "SELECT id FROM users;",
      };
      const result = workspace.analyze("postgres", files);
      strict.ok(result.problems.some(({ file, code }) => file === "schema/extra.sql" && code === "PLAY007"));
      strict.strictEqual(result.queries.length, 0);
    });
    await it("removes deleted modules and unresolved imports stay diagnostic", () => {
      const files: Record<string, string> = lessonFiles("postgres", "workspace", DEFAULT_SCHEMAS.postgres);
      strict.deepStrictEqual(workspace.analyze("postgres", files).problems, []);
      delete files["queries/account.sql"];
      const result = workspace.analyze("postgres", files);
      strict.ok(result.problems.some(({ code, file }) => code === "TS2307" && file === "app.ts"));
    });
    await it("keeps quoted semicolons, function bodies, and nested comments together", () => {
      const statements = splitSql(
        "-- x;\nCREATE FUNCTION f(a text) RETURNS text LANGUAGE SQL AS $body$ SELECT ';'; $body$;\n/* a /* b; */ c */ SELECT ';';",
        "f.sql",
      );
      strict.strictEqual(statements.length, 2);
      strict.ok(statements[0]!.text.includes("$body$ SELECT ';'; $body$"));
    });
    await it("validates file paths, workspace limits, and reserved virtual directories", () => {
      strict.strictEqual(filePathError("src/queries/account.sql"), undefined);
      for (const path of ["../escape.ts", "/absolute.sql", "node_modules/x.ts", "__sql__/x.ts", "file.js"])
        strict.ok(filePathError(path));
      strict.ok(validWorkspaceFiles({}));
      strict.ok(!validWorkspaceFiles({ "too-big.ts": "x".repeat(40_001) }));
      strict.ok(!validWorkspaceFiles({ "file.ts": "", "file.ts/nested.ts": "" }));
      strict.ok(validWorkspaceFiles({ "src/a.ts": "export {};", "schema/tables.sql": "" }));
    });
    await it("rejects conflicting table declarations across SQL files", () => {
      const files = {
        ...lessonFiles("postgres", "basics", DEFAULT_SCHEMAS.postgres),
        "schema/duplicate.sql": "CREATE TABLE users (id text);",
      };
      const result = workspace.analyze("postgres", files);
      strict.strictEqual(result.queries.length, 0);
      strict.ok(result.problems.some(({ code }) => code === "PLAY207"));
    });
    await it("fails closed for unsupported function signatures and bounds SQL parameter positions", () => {
      const files: Record<string, string> = {
        ...lessonFiles("postgres", "workspace", DEFAULT_SCHEMAS.postgres),
        "too-many.sql": "SELECT id FROM users WHERE id = $257;",
      };
      strict.ok(workspace.analyze("postgres", files).problems.some(({ code }) => code === "PLAY206"));
      files["schema/functions.sql"] =
        "CREATE FUNCTION bad(value text) RETURNS SETOF text LANGUAGE SQL AS $$ SELECT value $$;";
      const unsupported = workspace.analyze("postgres", files);
      strict.ok(unsupported.problems.some(({ code }) => code === "PLAY201"));
      strict.strictEqual(unsupported.queries.length, 0);
    });
    await it("keeps ambiguous named SQL exports unknown", () => {
      const files = {
        ...lessonFiles("postgres", "workspace", DEFAULT_SCHEMAS.postgres),
        "queries/account.sql":
          "-- name: accountById\nSELECT id FROM users;\n-- name: accountById\nSELECT email FROM users;",
      };
      const result = workspace.analyze("postgres", files);
      strict.ok(result.problems.some(({ code }) => code === "PLAY204"));
      strict.ok(!result.queries.some(({ file }) => file === "queries/account.sql"));
      const query = result.hovers["app.ts"]!.find(({ from }) => from === files["app.ts"].indexOf("sqlQuery ="));
      strict.match(query!.content, /unknown/u);
    });
  } finally {
    workspace.dispose();
  }
});
