import { describe, it, strict } from "poku";
import { DEFAULT_SCHEMAS, parsePlaygroundSchema } from "../../website/.vitepress/theme/playground/playground.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

const schema = DEFAULT_SCHEMAS.postgres;

await describe("playground module resolution", async () => {
  await it("preserves UTF-16 schema offsets through astral comments and uses qualified SQLite evidence", () => {
    const schema = "/*😀*/CREATE TABLE users (id BIGINT, id BIGINT);";
    const duplicate = parsePlaygroundSchema("postgres", schema).diagnostics.find(({ code }) => code === "PLAY007");
    strict.equal(duplicate?.column, schema.indexOf(", id") + 2);
    strict.equal(parsePlaygroundSchema("sqlite", DEFAULT_SCHEMAS.sqlite).snapshot?.server.version, "3.54.1");
  });
  const workspace = createTestWorkspace();
  try {
    await it("does not invent a directory import or missing TypeScript/SQL module", () => {
      for (const specifier of ["./queries", "./missing.ts", "./missing.sql"]) {
        const result = workspace.analyze("postgres", {
          "schema.sql": schema,
          "queries/account.ts": "export const accountById = (id: bigint) => id;",
          "app.ts": `import { accountById } from "${specifier}"; const value = accountById(1n);`,
        });
        strict.ok(
          result.problems.some(({ file, code }) => file === "app.ts" && code === "TS2307"),
          specifier,
        );
      }
    });
    await it("resolves explicit nested TypeScript and SQL query imports", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql": schema,
        "queries/account.sql": "SELECT id, email FROM users WHERE id = $1;",
        "queries/account.ts":
          'import { sql } from "@typed-sql/postgres"; export const accountById = (id: bigint) => sql`SELECT id, email FROM users WHERE id = ${id}`;',
        "src/app.ts":
          'import fromSql from "../queries/account.sql"; import { accountById } from "../queries/account.ts"; const sqlQuery = fromSql(1n); const tsQuery = accountById(1n);',
      });
      strict.deepStrictEqual(result.problems, []);
      strict.ok(result.hovers["src/app.ts"]!.some(({ content }) => content.includes("email: string")));
    });
    await it("reports missing named SQL exports and missing default exports", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql": schema,
        "queries/account.sql": "-- name: ids\nSELECT id FROM users;\n-- name: emails\nSELECT email FROM users;",
        "app.ts": 'import account, { missing } from "./queries/account.sql"; account(); missing();',
      });
      strict.ok(result.problems.some(({ file, code }) => file === "app.ts" && code === "TS1192"));
      strict.ok(result.problems.some(({ file, code }) => file === "app.ts" && code === "TS2305"));
    });
    await it("cannot shadow compiler-owned core contracts with a workspace file", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql": schema,
        "queries/account.sql": "SELECT id FROM users WHERE id = $1;",
        "core/index.ts":
          "export interface Query<Row, Params extends readonly unknown[] = readonly unknown[]> { lie: boolean; }",
        "app.ts": 'import query from "./queries/account.sql"; const lie = query(1n).lie;',
      });
      strict.ok(
        result.problems.some(
          ({ file, code, message }) => file === "app.ts" && code === "TS2339" && message.includes("lie"),
        ),
      );
    });
    await it("cannot shadow compiler-owned grammar declarations", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql": schema,
        "grammar.d.ts": "export declare const sql: any;",
        "app.ts": 'import { sql } from "@typed-sql/postgres"; const query = sql`SELECT id FROM users`;',
      });
      strict.deepStrictEqual(result.problems, []);
      strict.ok(result.hovers["app.ts"]!.some(({ content }) => content.includes("SqlTag")));
      strict.ok(!result.hovers["app.ts"]!.some(({ content }) => /^const query: any$/u.test(content)));
    });
    await it("does not expose internal declarations through an escaping relative import", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql": schema,
        "app.ts": 'import { sql } from "../grammar"; const query = sql`SELECT id FROM users`;',
      });
      strict.ok(result.problems.some(({ file, code }) => file === "app.ts" && code === "TS2307"));
    });
    await it("diagnoses imports from a grammar different from the selected database", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql": schema,
        "app.ts": 'import { sql } from "@typed-sql/mysql"; const query = sql`SELECT missing FROM users`;',
      });
      const mismatch = result.problems.find(({ code }) => code === "PLAY301")!;
      strict.ok(mismatch);
      strict.match(mismatch.message, /@typed-sql\/postgres/u);
      strict.strictEqual(result.queries.length, 0);
    });
    await it("handles a workspace containing SQL files only", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql": schema,
        "queries/account.sql": "SELECT id FROM users WHERE id = $1;",
      });
      strict.deepStrictEqual(result.problems, []);
      strict.strictEqual(result.queries[0]!.parameterType, "readonly [bigint]");
    });
    await it("rechecks missing imports when matching files are created or removed", () => {
      const files: Record<string, string> = {
        "schema.sql": schema,
        "app.ts":
          'import fromSql from "./queries/account.sql"; import { query } from "./queries/account.ts"; const sqlQuery = fromSql(1n); const tsQuery = query(1n);',
      };
      strict.strictEqual(
        workspace.analyze("postgres", files).problems.filter(({ code }) => code === "TS2307").length,
        2,
      );
      files["queries/account.sql"] = "SELECT id FROM users WHERE id = $1;";
      files["queries/account.ts"] =
        'import { sql } from "@typed-sql/postgres"; export const query = (id: bigint) => sql`SELECT id FROM users WHERE id = ${id}`;';
      strict.deepStrictEqual(workspace.analyze("postgres", files).problems, []);
      delete files["queries/account.sql"];
      delete files["queries/account.ts"];
      strict.strictEqual(
        workspace.analyze("postgres", files).problems.filter(({ code }) => code === "TS2307").length,
        2,
      );
    });
  } finally {
    workspace.dispose();
  }
});
