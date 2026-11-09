import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { parseDuckDBStatement } from "../src/parser/parser.js";
import { DuckDBParseError } from "../src/parser/tokenizer.js";
import { DUCKDB_SUPPORT_POLICY } from "../src/support-policy.js";
import { duckDBVocabulary } from "../src/vocabulary/index.js";
import type { DuckDBVocabulary } from "../src/vocabulary/types.js";
import { createDuckDBVocabulary } from "../src/vocabulary/vocabulary.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const facts = JSON.parse(
  await readFile(new URL("../../../grammar/duckdb/vocabulary/facts.json", import.meta.url), "utf8"),
) as {
  common: readonly (readonly [string, string, readonly string[]])[];
  profiles: readonly {
    version: string;
    words: readonly (readonly [string, string, readonly string[]])[];
    bareLabels: readonly string[];
  }[];
};

await describe("source-owned DuckDB keyword contexts", async () => {
  for (const version of DUCKDB_SUPPORT_POLICY.qualifiedEngines) {
    const profile = facts.profiles.find((profile) => profile.version === version)!;
    const { vocabulary } = (await import(`../src/vocabulary/generated/${version}.js`)) as {
      vocabulary: DuckDBVocabulary;
    };
    await it(`${version} applies every declared word in all eight independently qualified native identifier contexts`, () => {
      const bareLabels = new Set(profile.bareLabels);
      const mismatches: string[] = [];
      for (const [word, classes] of [...facts.common, ...profile.words]) {
        const identifier = /[UC]/u.test(classes);
        for (const [sql, allowed] of [
          [`SELECT 1 AS ${word}`, true],
          [`SELECT checked."${word}" FROM (SELECT 1 ${word}) AS checked`, bareLabels.has(word)],
          [`WITH seed AS (SELECT 1), ${word} AS (SELECT 1 AS x) SELECT x FROM ${word}`, identifier],
          [`SELECT 1 FROM (SELECT 1) AS ${word}`, identifier],
          [`SELECT 1 FROM (SELECT 1) ${word}`, identifier],
          [`SELECT fixture.${word} FROM (SELECT 1 AS "${word}") AS fixture`, true],
          [`WITH "${word}" AS (SELECT 1 AS x) SELECT x FROM "${word}"`, true],
          [`SELECT ${word}: 1`, identifier],
        ] as const) {
          let accepted = true;
          try {
            parseDuckDBStatement(sql, vocabulary);
          } catch (error) {
            if (!(error instanceof DuckDBParseError)) throw error;
            accepted = false;
          }
          if (accepted !== allowed) mismatches.push(`${allowed ? "rejected" : "accepted"}: ${sql}`);
        }
        strict.equal(vocabulary.lookup(word.toUpperCase()), vocabulary.lookup(word));
      }
      strict.deepEqual(mismatches, []);
    });
    await it(`${version} uses source vocabulary through the selected core analyzer`, async () => {
      const { duckdb } = await import(`../src/analysis/core/${version}.js`);
      const grammar = duckdb();
      const snapshot = grammar.validateSnapshot({
        formatVersion: 1,
        dialect: "duckdb",
        server: fixtureEvidence(version),
        tables: {},
      });
      for (const [word] of [...facts.common, ...profile.words]) {
        const source = `SELECT "${word}" + 1 FROM (SELECT 1 AS "${word}") AS fixture`;
        const result = grammar.analyze(source, snapshot);
        strict.deepEqual(result.diagnostics, [], source);
        strict.equal(result.columns[0]?.name, `("${word}" + 1)`, source);
        strict.equal(result.columns[0]?.tsType, "number", source);
      }
      for (const sql of [
        "SELECT 1 AS select",
        'WITH "select" AS (SELECT $1::INTEGER AS value) SELECT value FROM "select"',
        "SELECT try_cast FROM (SELECT 1 AS try_cast)",
        "SELECT coalesce($1::INTEGER, 1) AS value",
        'SELECT $1::INTEGER BETWEEN "from" AND $2::INTEGER AS value FROM (SELECT 1 AS "from")',
      ]) {
        const result = grammar.analyze(sql, snapshot);
        strict.deepEqual(result.diagnostics, [], sql);
        strict.ok(
          result.columns.every((column: { tsType: string }) => column.tsType !== "unknown"),
          sql,
        );
      }
      for (const sql of [
        "WITH select AS (SELECT 1 AS x) SELECT x FROM select",
        "SELECT 1 FROM (SELECT 1) AS select",
        "SELECT ſum(1) AS value",
        "SELECT Kurtosis(1) AS value",
        "SELECT show(NULL) AS value",
      ]) {
        const result = grammar.analyze(sql, snapshot);
        strict.ok(result.diagnostics.length > 0, sql);
        strict.ok(
          result.columns.every((column: { tsType: string }) => column.tsType === "unknown"),
          sql,
        );
      }
      const alias = grammar.analyze("SELECT 1 between", snapshot);
      strict.equal(alias.diagnostics.length === 0, version === "2.0.0");
      if (version === "2.0.0") strict.equal(alias.columns[0]?.name, "between");
    });
  }
  await it("owns immutable records and keeps unknown versions and Unicode lookalikes distinct", () => {
    const declarations: [string, string][] = [["sample", "U"]];
    const bare = ["sample"];
    const vocabulary = createDuckDBVocabulary(declarations, [], bare, [], "UF");
    declarations[0]![1] = "R";
    bare.length = 0;
    strict.equal(vocabulary.lookup("sample")?.identifier, true);
    strict.equal(vocabulary.lookup("sample")?.bareLabel, true);
    strict.ok(Object.isFrozen(vocabulary.lookup("sample")));
    strict.equal(vocabulary.lookup("ſample"), undefined);
    strict.equal(duckDBVocabulary("2.1.0"), undefined);
    strict.throws(() => createDuckDBVocabulary([["bad", "X"]], [], [], [], "UF"), TypeError);
  });
});
