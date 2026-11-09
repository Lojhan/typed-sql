import { DatabaseSync } from "node:sqlite";
import { describe, it, strict } from "poku";
import { sqlite } from "../src/analysis/core.js";
import { sqliteServerEvidence } from "../src/capabilities.js";
import { tokenize } from "../src/parser/index.js";
import { profiles } from "../src/vocabulary/generated/profiles.js";
import { sqliteVocabulary } from "../src/vocabulary/index.js";
import { createSqliteVocabulary, sqliteKeywordCondition } from "../src/vocabulary/vocabulary.js";

await describe("SQLite source-owned keyword and identifier contexts", async () => {
  for (const [version, vocabulary] of profiles) {
    await it(`${version} consumes every declaration across name and alias contexts`, () => {
      const lookup = vocabulary.forOptions();
      const dialect = sqlite();
      const snapshot = {
        formatVersion: 1 as const,
        dialect: "sqlite" as const,
        tables: {},
        version,
        server: sqliteServerEvidence(version),
      };
      const failures: string[] = [];
      for (const [name] of vocabulary.declarations) {
        const word = lookup(name);
        // Build-gated words absent from this configuration are ordinary identifiers.
        const isName = word?.identifier ?? true,
          bare = word?.bareAlias ?? true,
          bareColumn = word?.bareColumnAlias ?? true;
        strict.equal(lookup(name.toLowerCase()), word);
        strict.equal(tokenize(`"${name}"`, { keywordLookup: lookup })[0]!.nativeKeyword, undefined);
        const cases = [
          [`SELECT 1 AS ${name}`, isName],
          [`SELECT fixture."${name}" FROM (SELECT 1 ${name}) AS fixture`, bareColumn],
          [`WITH seed AS (SELECT 1 AS n), ${name} AS (SELECT 1 AS n) SELECT n FROM ${name}`, isName],
          [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture AS ${name}`, isName],
          [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture ${name}`, bare],
          [`WITH fixture AS (SELECT 1 AS "${name}") SELECT fixture.${name} AS value FROM fixture`, isName],
        ] as const;
        for (const [sql, expected] of cases) {
          const result = dialect.analyze(sql, snapshot);
          if (expected ? result.diagnostics.length > 0 : !result.diagnostics.some((d) => d.severity === "error"))
            failures.push(`${name}: ${sql}: ${result.diagnostics.map((d) => d.code).join(",")}`);
        }
        const quoted = dialect.analyze(`WITH "${name}" AS (SELECT 1 AS value) SELECT value FROM "${name}"`, snapshot);
        if (quoted.diagnostics.length) failures.push(`quoted:${name}`);
      }
      strict.deepEqual(failures, []);
    });
  }
  await it("matches independently prepared native alias and identifier contexts without executing candidates", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const version = database.prepare("SELECT sqlite_version() AS version").get()!.version as string;
      const options = database
        .prepare("PRAGMA compile_options")
        .all()
        .map((row) => String(row.compile_options));
      const vocabulary = sqliteVocabulary(version),
        lookup = vocabulary.forOptions(options);
      const failures: string[] = [];
      for (const [name] of vocabulary.declarations) {
        const word = lookup(name),
          isName = word?.identifier ?? true,
          bare = word?.bareAlias ?? true,
          bareColumn = word?.bareColumnAlias ?? true;
        const cases = [
          [`SELECT 1 AS ${name}`, isName],
          [`SELECT fixture."${name}" FROM (SELECT 1 ${name}) AS fixture`, bareColumn],
          [`WITH seed AS (SELECT 1 AS n), ${name} AS (SELECT 1 AS n) SELECT n FROM ${name}`, isName],
          [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture AS ${name}`, isName],
          [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture ${name}`, bare],
          [`WITH fixture AS (SELECT 1 AS "${name}") SELECT fixture.${name} AS value FROM fixture`, isName],
        ] as const;
        for (const [sql, expected] of cases) {
          let accepted = false;
          try {
            const statement = database.prepare(sql);
            accepted = true;
            if ("close" in statement && typeof statement.close === "function") statement.close();
          } catch (error) {
            if ((error as { code?: string }).code !== "ERR_SQLITE_ERROR") throw error;
          }
          if (accepted !== expected) failures.push(`${name}:${sql}:native=${accepted},source=${expected}`);
        }
      }
      strict.deepEqual(failures, []);
    } finally {
      database.close();
    }
  });
  await it("uses source build guards and the observed 3.42 identifier-expression transition", () => {
    strict.equal(sqliteVocabulary("3.41.2").forOptions()("LEFT")!.expression, false);
    strict.equal(sqliteVocabulary("3.42.0").forOptions()("LEFT")!.expression, true);
    const latest = profiles.at(-1)![1];
    strict.equal(latest.forOptions()("WITHIN"), undefined);
    strict.equal(latest.forOptions(["ENABLE_ORDERED_SET_AGGREGATES"])("WITHIN")!.fallback, true);
    strict.equal(latest.forOptions(["OMIT_COMPOUND_SELECT"])("UNION"), undefined);
    strict.equal(latest.forOptions(["OMIT_WINDOWFUNC"])("WINDOW"), undefined);
    strict.equal(sqliteKeywordCondition(["or", "ENABLED", ["not", "OMITTED"]], new Set(["OMITTED"])), false);
    const rows = [["WORD", "ID", ["ALWAYS"], false, 7, false, false, false]] as const;
    const vocabulary = createSqliteVocabulary(rows, [], { ALWAYS: true });
    strict.ok(Object.isFrozen(vocabulary.declarations[0]));
    strict.throws(() => createSqliteVocabulary(rows, rows, { ALWAYS: true }), /Duplicate/u);
    strict.equal(vocabulary.forOptions()("ſelect"), undefined);
  });
});
