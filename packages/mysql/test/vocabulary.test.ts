import { describe, it, strict } from "poku";
import { mysql as selected } from "../src/analysis/core/8.4.js";
import { mySqlServerEvidence } from "../src/capabilities.js";
import { tokenize } from "../src/parser/index.js";
import { MYSQL_SUPPORT_POLICY } from "../src/support.js";
import { mySqlVocabulary } from "../src/vocabulary/index.js";
import type { MySqlVocabulary } from "../src/vocabulary/types.js";

const versions = [...MYSQL_SUPPORT_POLICY.stable, MYSQL_SUPPORT_POLICY.canary];
await describe("MySQL source-owned vocabulary and function-name contexts", async () => {
  for (const target of versions) {
    const series = target.series;
    const { vocabulary, source } = (await import(`../src/vocabulary/generated/${series}.js`)) as {
      vocabulary: MySqlVocabulary;
      source: { version: string };
    };
    const { mysql } = (await import(`../src/analysis/core/${series}.js`)) as { mysql: typeof selected };
    for (const sqlMode of ["", "IGNORE_SPACE"]) {
      await it(`${series} consumes every word across identifier and alias contexts (${sqlMode || "no IGNORE_SPACE"})`, () => {
        const dialect = mysql(series === MYSQL_SUPPORT_POLICY.canary.series ? { versionPolicy: "canary" } : {});
        const schema = {
          formatVersion: 1 as const,
          dialect: "mysql" as const,
          tables: {},
          server: mySqlServerEvidence(source.version, { sqlMode, versionComment: "MySQL Community Server - GPL" }),
        };
        const lookup = vocabulary.forMode(sqlMode),
          failures: string[] = [];
        for (const [upper] of vocabulary.declarations) {
          const word = lookup(upper)!,
            name = upper.toLowerCase(),
            identifier = !word.reserved,
            bareColumn = identifier && !word.infix;
          strict.equal(lookup(name), word);
          strict.equal(tokenize(`\`${name}\``, { sqlMode, keywordLookup: lookup })[0]!.nativeKeyword, undefined);
          const cases = [
            [`SELECT 1 AS ${name}`, identifier],
            [`SELECT fixture.\`${name}\` FROM (SELECT 1 ${name}) AS fixture`, bareColumn],
            [`WITH seed AS (SELECT 1 AS n), ${name} AS (SELECT 1 AS n) SELECT n FROM ${name}`, identifier],
            [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture AS ${name}`, identifier],
            [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture ${name}`, identifier],
            [`WITH fixture AS (SELECT 1 AS \`${name}\`) SELECT fixture.${name} AS value FROM fixture`, true],
            [`WITH \`${name}\` AS (SELECT 1 AS value) SELECT value FROM \`${name}\``, true],
          ] as const;
          for (const [sql, expected] of cases) {
            const result = dialect.analyze(sql, schema);
            if (expected ? result.diagnostics.length > 0 : !result.diagnostics.some((d) => d.severity === "error"))
              failures.push(`${upper}:${sql}:${result.diagnostics.map((d) => d.code).join(",")}`);
          }
        }
        strict.deepEqual(failures, []);
      });
    }
  }
  await it("does not substitute native semantics for ordinary, quoted or Unicode-lookalike calls", () => {
    const dialect = selected(),
      base = { formatVersion: 1 as const, dialect: "mysql" as const, tables: {} };
    const schema = (sqlMode: string) => ({
      ...base,
      server: mySqlServerEvidence("8.4.11", { sqlMode, versionComment: "MySQL Community Server - GPL" }),
    });
    for (const sql of [
      "SELECT SUM (CAST(? AS SIGNED)) AS value",
      "SELECT `SUM`(CAST(? AS SIGNED)) AS value",
      "SELECT `IF`(1,2,3) AS value",
      "SELECT `COALESCE`(1,2) AS value",
      "SELECT ſum(CAST(? AS SIGNED)) AS value",
    ]) {
      const result = dialect.analyze(sql, schema(""));
      strict.ok(
        result.diagnostics.some((d) => d.code === "TSQ408"),
        sql,
      );
      strict.equal(result.columns[0]?.tsType, "unknown", sql);
      if (sql.includes("?")) {
        strict.equal(result.parameters.length, 1);
        strict.equal(result.parameters[0]?.tsType, "bigint");
        strict.equal(dialect.parameterOccurrences!(sql, schema(""))[0]?.range.start, sql.indexOf("?"));
        strict.ok(
          result.diagnostics.every((d) => d.range.start >= sql.indexOf("SELECT") + 6 && d.range.end <= sql.length),
        );
      }
    }
    for (const sql of ["SELECT SUM(CAST(? AS SIGNED)) AS value", "SELECT SUM (CAST(? AS SIGNED)) AS value"]) {
      strict.deepEqual(dialect.analyze(sql, schema("IGNORE_SPACE")).diagnostics, []);
    }
    strict.deepEqual(dialect.analyze("SELECT `LOG`(1) AS value", schema("")).diagnostics, []);
    strict.equal(mySqlVocabulary("8.4")!.forMode()("REVERSE")!.ordinaryFunction, true);
    strict.ok(
      dialect.analyze("SELECT `REVERSE`('x') AS value", schema("")).diagnostics.some((d) => d.code === "TSQ408"),
    );
    strict.ok(dialect.analyze("SELECT ABS\u00a0(1) AS value", schema("")).diagnostics.some((d) => d.code === "TSQ001"));
    strict.ok(
      dialect
        .analyze("SELECT SUM /* comment */(1) AS value", schema("IGNORE_SPACE"))
        .diagnostics.some((d) => d.code === "TSQ408"),
    );
    strict.ok(dialect.analyze("SELECT LANGUAGE(1) AS value", schema("")).diagnostics.some((d) => d.code === "TSQ001"));
    strict.ok(
      dialect.analyze("SELECT app.GROUPING(1) AS value", schema("")).diagnostics.some((d) => d.code === "TSQ408"),
    );
    strict.equal(mySqlVocabulary("99.0"), undefined);
  });
});
