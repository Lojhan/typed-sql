import { queryContractDigest } from "@typed-sql/analysis";
import { describe, it, strict } from "poku";
import { postgres as pg18 } from "../src/analysis/core/18.js";
import { POSTGRES_SUPPORT_POLICY, postgresServerEvidence } from "../src/analysis.js";
import { postgresContractAdapterVersion, postgresContractIdentity } from "../src/contract-profile.js";
import { tokenize } from "../src/parser/index.js";
import { postgresVocabulary } from "../src/vocabulary/index.js";
import type { PostgresVocabulary } from "../src/vocabulary/types.js";
import { createPostgresVocabulary } from "../src/vocabulary/vocabulary.js";

const majors = [...POSTGRES_SUPPORT_POLICY.stableMajors, POSTGRES_SUPPORT_POLICY.canary.major];
await describe("version-owned PostgreSQL keyword vocabulary", async () => {
  for (const major of majors) {
    const { vocabulary, source } = (await import(`../src/vocabulary/generated/${major}.js`)) as {
      vocabulary: PostgresVocabulary;
      source: { version: string };
    };
    const { postgres } = (await import(`../src/analysis/core/${major}.js`)) as { postgres: typeof pg18 };
    const dialect = postgres(major === POSTGRES_SUPPORT_POLICY.canary.major ? { versionPolicy: "canary" } : {});
    const schema = dialect.validateSnapshot({
      formatVersion: 1,
      dialect: "postgres",
      tables: {},
      server: postgresServerEvidence(source.version),
    });
    await it(`${major} classifies the complete inventory without classifying quoted names or Unicode lookalikes`, () => {
      strict.ok(Object.isFrozen(vocabulary));
      strict.ok(Object.isFrozen(vocabulary.words));
      for (const word of vocabulary.words) {
        strict.ok(Object.isFrozen(word));
        strict.equal(vocabulary.lookup(word.name), word);
        strict.equal(vocabulary.lookup(word.name.toUpperCase()), word);
        strict.equal(tokenize(word.name, { keywordLookup: vocabulary.lookup })[0]!.nativeKeyword, word);
        const quoted = tokenize(`"${word.name.toUpperCase()}"`, { keywordLookup: vocabulary.lookup })[0]!;
        strict.equal(quoted.kind, "quoted-identifier");
        strict.equal(quoted.nativeKeyword, undefined);
        const alias = dialect.analyze(`SELECT 1 AS ${word.name}`, schema);
        strict.deepEqual(alias.diagnostics, [], word.name);
        strict.equal(alias.columns[0]!.name, word.name);
      }
      for (const word of ["ſelect", "Key", "a$select", "select1", "", "vendor_word"])
        strict.equal(vocabulary.lookup(word), undefined);
      strict.equal(tokenize("ſelect", { keywordLookup: vocabulary.lookup })[0]!.kind, "identifier");
    });
    await it(`${major} applies native ColId classes to CTE names and column references`, () => {
      const failures: string[] = [];
      for (const word of vocabulary.words) {
        const colId = word.category === "UNRESERVED_KEYWORD" || word.category === "COL_NAME_KEYWORD";
        const result = dialect.analyze(
          `WITH seed AS (SELECT 1 AS n), ${word.name} AS (SELECT 1 AS value) SELECT value FROM ${word.name}`,
          schema,
        );
        if (colId ? result.diagnostics.length > 0 : !result.diagnostics.some(({ severity }) => severity === "error"))
          failures.push(`cte:${word.name}:${result.diagnostics.map(({ code }) => code).join(",")}`);
        if (colId) {
          const column = dialect.analyze(
            `WITH fixture AS (SELECT 1 AS "${word.name}") SELECT ${word.name} AS value FROM fixture`,
            schema,
          );
          if (column.diagnostics.length || column.columns[0]?.tsType !== "number")
            failures.push(`column:${word.name}:${column.diagnostics.map(({ code }) => code).join(",")}`);
        }
      }
      for (const word of vocabulary.words) {
        const bare = dialect.analyze(`SELECT 1 ${word.name}`, schema);
        if (
          word.bareLabel
            ? bare.diagnostics.length > 0 || bare.columns[0]?.name !== word.name
            : !bare.diagnostics.some(({ severity }) => severity === "error")
        )
          failures.push(`bare:${word.name}:${bare.diagnostics.map(({ code }) => code).join(",")}`);
        const qualified = dialect.analyze(
          `WITH fixture AS (SELECT 1 AS "${word.name}") SELECT fixture.${word.name} AS value FROM fixture`,
          schema,
        );
        if (qualified.diagnostics.length || qualified.columns[0]?.tsType !== "number")
          failures.push(`qualified:${word.name}`);
        const colId = word.category === "UNRESERVED_KEYWORD" || word.category === "COL_NAME_KEYWORD";
        const alias = dialect.analyze(
          `WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture AS ${word.name}`,
          schema,
        );
        if (colId ? alias.diagnostics.length > 0 : !alias.diagnostics.some(({ severity }) => severity === "error"))
          failures.push(`relation-alias:${word.name}`);
      }
      strict.deepEqual(failures, []);
    });
  }
  await it("owns immutable snapshots and invalidates the preceding interpretation revision", () => {
    const known = postgresVocabulary()!;
    const word = known.words[0]!;
    const declaration = [word.name, word.category, word.bareLabel, word.token] as const;
    const input = [declaration];
    const snapshot = createPostgresVocabulary(input, []);
    input.pop();
    strict.equal(snapshot.lookup(word.name)?.name, word.name);
    strict.throws(() => createPostgresVocabulary([declaration], [declaration]), /Duplicate/u);
    strict.equal(postgresVocabulary(99), undefined);
    strict.notEqual(postgresContractIdentity().interpreterHash, queryContractDigest(postgresContractAdapterVersion));
  });
  await it("does not bind Unicode lookalikes to ASCII identifiers or builtin routines", () => {
    const dialect = pg18();
    const schema = dialect.validateSnapshot({
      formatVersion: 1,
      dialect: "postgres",
      server: postgresServerEvidence("18.6"),
      tables: {
        fixture: {
          name: "fixture",
          columns: {
            Key: { name: "Key", databaseType: "integer", tsType: "number", nullable: false },
            key: { name: "key", databaseType: "text", tsType: "string", nullable: false },
          },
        },
      },
    });
    const query = dialect.analyze("SELECT Key AS value FROM fixture", schema);
    strict.deepEqual(query.diagnostics, []);
    strict.equal(query.columns[0]!.tsType, "number");
    const unknown = dialect.analyze("SELECT ſum($1::integer) AS value", schema);
    strict.ok(unknown.diagnostics.some(({ code }) => code === "TSQ408"));
    strict.equal(unknown.columns[0]?.tsType, "unknown");
    strict.equal(unknown.parameters[0]?.tsType, "number");
  });
});
