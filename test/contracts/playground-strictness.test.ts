import { describe, it, strict } from "poku";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

await describe("playground SQL strictness", async () => {
  const workspace = createTestWorkspace();
  try {
    for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
      await it(`rejects qualified/unqualified duplicate ${dialect} tables`, () => {
        const namespace = dialect === "postgres" ? "public" : dialect === "mysql" ? "app" : "main";
        const schema =
          dialect === "sqlite"
            ? `CREATE TABLE users(id INTEGER NOT NULL) STRICT; CREATE TABLE ${namespace}.users(id TEXT NOT NULL) STRICT;`
            : `CREATE TABLE users(id bigint NOT NULL); CREATE TABLE ${namespace}.users(id text NOT NULL);`;
        const result = workspace.analyze(dialect, {
          "schema/tables.sql": schema,
          "queries/account.sql": `SELECT id FROM ${namespace}.users;`,
          "app.ts": 'import account from "./queries/account.sql"; const result = account();',
        });
        strict.ok(result.problems.some(({ code, file }) => code === "PLAY207" && file === "schema/tables.sql"));
        strict.strictEqual(result.queries.length, 0);
        const resultHover = result.hovers["app.ts"]!.find(
          ({ from }) => from === 'import account from "./queries/account.sql"; const '.length,
        );
        strict.match(resultHover!.content, /unknown/u);
      });
    }
    await it("normalizes PostgreSQL quoted identifiers without merging distinct case-sensitive names", () => {
      const duplicate = workspace.analyze("postgres", {
        "schema.sql": 'CREATE TABLE users(id bigint); CREATE TABLE "public"."users"(id text);',
        "query.sql": "SELECT id FROM users;",
      });
      strict.ok(duplicate.problems.some(({ code }) => code === "PLAY207"));
      strict.strictEqual(duplicate.queries.length, 0);
      const distinct = workspace.analyze("postgres", {
        "schema.sql": 'CREATE TABLE users(id bigint); CREATE TABLE "Users"(id text);',
        "query.sql": "SELECT id FROM users;",
      });
      strict.ok(!distinct.problems.some(({ code }) => code === "PLAY207"));
    });
    await it("rejects duplicate enum identities across SQL schema files", () => {
      const result = workspace.analyze("postgres", {
        "schema/a.sql": "CREATE TYPE status AS ENUM ('a');",
        "schema/b.sql": "CREATE TYPE public.status AS ENUM ('b');",
        "query.sql": "SELECT 'a'::status AS status;",
      });
      strict.ok(result.problems.some(({ code, file }) => code === "PLAY207" && file === "schema/b.sql"));
      strict.strictEqual(result.queries.length, 0);
    });
    await it("fails closed on unknown trailing column syntax", () => {
      for (const attributes of [
        "NOT NULL nonsense",
        "NULL NOT NULL",
        "DEFAULT 'safe' nonsense",
        "GENERATED ALWAYS AS IDENTITY nonsense",
        "REFERENCES other(id) nonsense",
        "CHECK (id > 0) nonsense",
        'COLLATE "C" nonsense',
        "AUTO_INCREMENT nonsense",
      ]) {
        const result = workspace.analyze("postgres", {
          "schema.sql": `CREATE TABLE users(id bigint ${attributes});`,
          "query.sql": "SELECT id FROM users;",
        });
        strict.ok(
          result.problems.some(({ code }) => code === "PLAY006"),
          attributes,
        );
        strict.strictEqual(result.queries.length, 0, attributes);
      }
    });
    await it("does not infer column constraints from string literals", () => {
      const result = workspace.analyze("postgres", {
        "schema.sql":
          "CREATE TABLE users(value text DEFAULT 'NOT NULL', other text DEFAULT 'PRIMARY KEY', note text CHECK(note <> 'NOT NULL'));",
        "query.sql": "SELECT value, other, note FROM users;",
      });
      strict.deepStrictEqual(result.problems, []);
      strict.match(result.queries[0]!.rowType, /"value": string \| null/u);
      strict.match(result.queries[0]!.rowType, /"other": string \| null/u);
      strict.match(result.queries[0]!.rowType, /"note": string \| null/u);
    });
    await it("rejects malformed table constraint scaffolding instead of silently dropping it", () => {
      for (const constraint of [
        "PRIMARY KEY nonsense",
        "UNIQUE (id) nonsense",
        "CHECK (id > 0) nonsense",
        "FOREIGN KEY (id) nonsense",
        "CONSTRAINT named garbage",
      ]) {
        const result = workspace.analyze("postgres", {
          "schema.sql": `CREATE TABLE users(id bigint, ${constraint});`,
          "query.sql": "SELECT id FROM users;",
        });
        strict.ok(
          result.problems.some(({ code }) => code === "PLAY006"),
          constraint,
        );
        strict.strictEqual(result.queries.length, 0, constraint);
      }
    });
    await it("keeps constraint words inside MySQL enum labels inside the type", () => {
      const result = workspace.analyze("mysql", {
        "schema.sql": "CREATE TABLE users(status ENUM('is NOT NULL', 'PRIMARY KEY') NOT NULL);",
        "query.sql": "SELECT status FROM users;",
      });
      strict.deepStrictEqual(result.problems, []);
      strict.match(result.queries[0]!.rowType, /is NOT NULL/u);
    });
    await it("reads query names only from leading line comments", () => {
      for (const query of [
        "SELECT '-- name: hijack' AS value;",
        "/* -- name: hijack */ SELECT 1 AS value;",
        "SELECT 1 AS value -- name: hijack\n;",
      ]) {
        const result = workspace.analyze("postgres", { "queries/actual.sql": query });
        strict.deepStrictEqual(result.problems, []);
        strict.strictEqual(result.queries[0]!.binding, "actual");
      }
      const named = workspace.analyze("postgres", {
        "query.sql": "/* documentation */\n-- Some notes\n-- name: genuine\nSELECT '-- name: hijack' AS value;",
      });
      strict.deepStrictEqual(named.problems, []);
      strict.strictEqual(named.queries[0]!.binding, "genuine");
    });
  } finally {
    workspace.dispose();
  }
});
