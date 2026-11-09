import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { sqlServerNativePermissions } from "../../../scripts/vocabulary/sqlserver-policy.mjs";
import { sqlServerVocabularyCases } from "../../../scripts/vocabulary/sqlserver-probes.mjs";
import { sqlserver } from "../src/analysis/core.js";
import { parseStatement, SqlServerParseError } from "../src/parser/index.js";
import { sqlServerVocabulary } from "../src/vocabulary/generated/profiles.js";
import { maturitySnapshot } from "./helpers/maturity-corpus.js";

const facts = JSON.parse(
  await readFile(new URL("../../../grammar/sqlserver/vocabulary/facts.json", import.meta.url), "utf8"),
);
const qualification = JSON.parse(
  await readFile(new URL("../../../grammar/sqlserver/vocabulary/qualification.json", import.meta.url), "utf8"),
);

await describe("native-qualified SQL Server identifier contexts", async () => {
  for (const profile of facts.profiles) {
    for (const level of profile.compatibilityLevels) {
      await it(`${profile.major}/${level} applies every independently inventoried word in all eight native contexts`, () => {
        const vocabulary = sqlServerVocabulary(profile.major, level)!;
        strict.ok(vocabulary);
        const permissions = sqlServerNativePermissions(facts, qualification, profile.major, level);
        const mismatches: string[] = [];
        for (const item of sqlServerVocabularyCases([...facts.common, ...profile.words])) {
          let accepted = true;
          try {
            parseStatement(item.sql, { vocabulary });
          } catch (error) {
            if (!(error instanceof SqlServerParseError)) throw error;
            accepted = false;
          }
          const expected = (permissions.get(item.word)! & (1 << (item.id % 8))) !== 0;
          strict.equal(vocabulary.allows(item.word.toUpperCase(), item.role), expected);
          if (accepted !== expected) mismatches.push(`${expected ? "rejected" : "accepted"}: ${item.sql}`);
        }
        strict.deepEqual(mismatches, []);
      });
      await it(`${profile.major}/${level} preserves quoted keyword column inference in the selected core`, () => {
        const grammar = sqlserver();
        const snapshot = grammar.validateSnapshot(
          maturitySnapshot(`${profile.major}.0.1.0`, "Latin1_General_100_CI_AS", level),
        );
        for (const [word] of [...facts.common, ...profile.words]) {
          const source = `SELECT [${word}] + 1 AS value FROM (SELECT 1 AS [${word}]) AS fixture`;
          const result = grammar.analyze(source, snapshot);
          strict.deepEqual(result.diagnostics, [], source);
          strict.equal(result.columns[0]?.tsType, "number", source);
          strict.equal(result.columns[0]?.nullable, false, source);
          strict.deepEqual(result.parameters, [], source);
        }
        const invalid = "SELECT 1 AS select";
        const rejected = grammar.analyze(invalid, snapshot);
        strict.equal(rejected.columns.length, 0);
        strict.ok(rejected.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
        strict.equal(rejected.diagnostics[0]?.range.start, invalid.lastIndexOf("select"));
        const valid = "SELECT CAST(@p1 AS int) + [NULL] AS value FROM (SELECT 1 AS [NULL]) AS fixture";
        const bound = grammar.analyze(valid, snapshot);
        strict.deepEqual(bound.diagnostics, [], valid);
        strict.equal(bound.columns[0]?.tsType, "number");
        strict.equal(bound.parameters.length, 1);
        strict.equal(bound.parameters[0]?.index, 1);
        const statement = parseStatement(valid, { vocabulary: sqlServerVocabulary(profile.major, level)! });
        strict.equal(statement.kind, "select");
      });
    }
  }
});
