import { describe, it, strict } from "poku";
import { DEFAULT_SCHEMAS, PLAYGROUND_DIALECTS } from "../../website/.vitepress/theme/playground/playground.js";
import { LESSONS, lessonFiles, lessonSupportsDialect } from "../../website/.vitepress/theme/playground/workspace.js";
import {
  decodeSharedWorkspace,
  defaultPlaygroundState,
  identifyExample,
  restorePlaygroundState,
  upgradeLegacyWorkspace,
} from "../../website/.vitepress/theme/playground/workspace-storage.js";
import { createTestWorkspace } from "../helpers/playground-workspace.js";

function legacyStarter() {
  const files = lessonFiles("postgres", "basics", DEFAULT_SCHEMAS.postgres);
  return {
    "app.ts": files["app.ts"].replace("./queries/account.ts", "./queries"),
    "queries.ts": files["queries/account.ts"],
    "schema.sql": files["schema/tables.sql"],
  };
}

await describe("playground examples and saved workspaces", async () => {
  const service = createTestWorkspace();
  try {
    for (const dialect of PLAYGROUND_DIALECTS) {
      await it(`${dialect} starter actually consumes both SQL and TypeScript exports`, () => {
        const files = lessonFiles(dialect, "workspace", DEFAULT_SCHEMAS[dialect]);
        strict.ok(!("queries.ts" in files));
        strict.ok(!("schema.sql" in files));
        strict.match(files["app.ts"], /import accountFromSql from "\.\/queries\/account\.sql"/u);
        strict.match(files["app.ts"], /import \{ accountById \} from "\.\/queries\/account\.ts"/u);
        strict.match(files["app.ts"], /database\.all\(sqlQuery\)/u);
        strict.match(files["app.ts"], /database\.all\(templateQuery\)/u);
        const result = service.analyze(dialect, files);
        strict.deepStrictEqual(result.problems, []);
        for (const binding of ["sqlQuery", "templateQuery", "sqlRows", "templateRows"]) {
          const hover = result.hovers["app.ts"]!.find(({ from }) => from === files["app.ts"].indexOf(`${binding} =`));
          strict.match(hover!.content, /email: string/u);
          strict.ok(!hover!.content.includes("any"));
        }
        files["app.ts"] = files["app.ts"].replace("./queries/account.ts", "./queries");
        strict.ok(service.analyze(dialect, files).problems.some(({ code }) => code === "TS2307"));
      });
      await it(`all ${dialect} examples reference existing query files`, () => {
        for (const { id } of LESSONS) {
          if (!lessonSupportsDialect(id, dialect)) continue;
          const files = lessonFiles(dialect, id, DEFAULT_SCHEMAS[dialect]);
          strict.ok("queries/account.ts" in files);
          strict.ok(!("queries.ts" in files));
          strict.strictEqual(identifyExample(dialect, files), id);
          const problems = service.analyze(dialect, files).problems;
          if (id !== "errors" && id !== "unknown") strict.deepStrictEqual(problems, []);
          strict.ok(!problems.some(({ code }) => code === "TS2307"));
        }
      });
    }
    await it("upgrades exact legacy starters to explicit mixed imports", () => {
      const migrated = upgradeLegacyWorkspace("postgres", legacyStarter());
      strict.match(migrated.files["app.ts"]!, /accountFromSql/u);
      strict.ok(!("queries.ts" in migrated.files));
      strict.ok(!("schema.sql" in migrated.files));
      strict.strictEqual(migrated.example, "workspace");
      strict.deepStrictEqual(service.analyze("postgres", migrated.files).problems, []);
    });
    await it("preserves legacy projects with extra files and their existing imports", () => {
      const files = {
        ...legacyStarter(),
        "consumer.ts": 'export { accountById } from "./queries";',
        "queries/recent.sql": "SELECT email FROM users;",
      };
      const migrated = upgradeLegacyWorkspace("postgres", files);
      strict.deepStrictEqual(migrated.files, files);
      strict.strictEqual(migrated.example, "custom");
      strict.deepStrictEqual(service.analyze("postgres", migrated.files).problems, []);
    });
    await it("preserves edited legacy sources as Custom without injecting unrelated defaults", () => {
      const files = legacyStarter();
      files["app.ts"] += "\n// My own application\n";
      const restored = restorePlaygroundState(undefined, { postgres: files });
      strict.deepStrictEqual(restored.workspaces.postgres.files, files);
      strict.strictEqual(restored.workspaces.postgres.example, "custom");
      strict.ok(!("queries/account.sql" in restored.workspaces.postgres.files));
    });
    await it("preserves modified files that collide with migration targets", () => {
      const files = { ...legacyStarter(), "queries/account.ts": "export const mine = true;" };
      const migrated = upgradeLegacyWorkspace("postgres", files);
      strict.deepStrictEqual(migrated.files, files);
      strict.strictEqual(migrated.example, "custom");
    });
    await it("shared snapshots remain exact even when they resemble an old starter", () => {
      const files = legacyStarter();
      const shared = decodeSharedWorkspace({ dialect: "postgres", lesson: "workspace", files })!;
      strict.deepStrictEqual(shared.workspace.files, files);
      strict.strictEqual(shared.workspace.example, "custom");
      strict.ok(!("queries/account.sql" in shared.workspace.files));
      strict.strictEqual(decodeSharedWorkspace({ dialect: "invalid", files }), undefined);
    });
    await it("restores per-dialect examples and labels changed content Custom", () => {
      const saved = defaultPlaygroundState();
      saved.dialect = "mysql";
      saved.workspaces.postgres = {
        files: lessonFiles("postgres", "basics", DEFAULT_SCHEMAS.postgres),
        example: "basics",
      };
      saved.workspaces.mysql = { files: lessonFiles("mysql", "joins", DEFAULT_SCHEMAS.mysql), example: "joins" };
      saved.workspaces.sqlite.files["app.ts"] += "\n// Changed\n";
      const restored = restorePlaygroundState(JSON.parse(JSON.stringify(saved)));
      strict.strictEqual(restored.dialect, "mysql");
      strict.strictEqual(restored.workspaces.postgres.example, "basics");
      strict.strictEqual(restored.workspaces.mysql.example, "joins");
      strict.strictEqual(restored.workspaces.sqlite.example, "custom");
      strict.deepStrictEqual(restored.workspaces.sqlite.files, saved.workspaces.sqlite.files);
    });
  } finally {
    service.dispose();
  }
});
