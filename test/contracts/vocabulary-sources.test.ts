import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { parseSqlServerVocabulary } from "../../scripts/vocabulary/sqlserver.mjs";
import { auditSqlServerVocabulary, sqlServerVocabularyCases } from "../../scripts/vocabulary/sqlserver-probes.mjs";

const facts = {
  formatVersion: 1,
  common: [
    ["ordinary", null, []],
    ["select", "Select", []],
  ],
  profiles: [
    { major: 17, compatibilityLevels: [140, 150, 160, 170], words: [], sourceDigest: "source", wordsDigest: "words" },
  ],
};
const cases = sqlServerVocabularyCases(facts.common);
const expectedRows = (ids: number[]) =>
  ids.map((id) => ({
    probe_id: id,
    column_ordinal: 1,
    error_number: cases[id]!.expected ? null : 156,
    name: cases[id]!.name,
  }));

await describe("source vocabulary extraction and native audit boundaries", async () => {
  await it("retains declared reservation separately from contextual words and non-word constants", () => {
    const common = 'tokens {\nSelect="select"; Identifier;\n}\n';
    const parser = `identifier returns [Identifier result]\n : tId:Identifier { Use(tId); } | tQuoted:QuotedIdentifier { Use(tQuoted); };\nclass TSql170LexerInternal extends Lexer("TSqlLexerBaseInternal");\noptions {caseSensitive=false;caseSensitiveLiterals=false;importVocab=TSql;}\ntokens {\nPivot="pivot";\n}\n`;
    const constants =
      'internal const string Ordinary="ORDINARY";\ninternal const string SelectName="SELECT";\ninternal const string Phrase="TWO WORDS";';
    const result = parseSqlServerVocabulary(common, parser, constants, 17);
    strict.deepEqual(result.words, [
      ["ordinary", null, ["Ordinary"]],
      ["pivot", "Pivot", []],
      ["select", "Select", ["SelectName"]],
    ]);
    strict.deepEqual(result.nonWords, [["Phrase", "TWO WORDS"]]);
    for (const malformed of [
      common.replace("Identifier;", 'Unknown("extension");'),
      common.replace("Identifier;", "#if FUTURE\nIdentifier;\n#endif"),
    ])
      strict.throws(() => parseSqlServerVocabulary(malformed, parser, constants, 17));
    strict.throws(() =>
      parseSqlServerVocabulary(common, parser.replace("tId:Identifier", "tId:NewKeyword"), constants, 17),
    );
    strict.throws(() =>
      parseSqlServerVocabulary(common, parser, constants + "\ninternal const string Dynamic=GetValue();", 17),
    );
  });
  await it("covers every declared word/context and preserves native permission masks", async () => {
    const seen = new Set<number>();
    const report = await auditSqlServerVocabulary(
      {
        all: async (sql: string) => {
          strict.ok(sql.startsWith("SELECT candidate.probe_id"));
          strict.ok(sql.includes("sys.dm_exec_describe_first_result_set"));
          const ids = [...sql.matchAll(/\((\d+),N'/gu)].map((match) => Number(match[1]));
          for (const id of ids) {
            strict.ok(!seen.has(id));
            seen.add(id);
          }
          return expectedRows(ids);
        },
      },
      17,
      160,
      { facts },
    );
    strict.equal(report.status, "matched");
    strict.equal(report.probes, 16);
    strict.equal(seen.size, 16);
    strict.deepEqual(report.permissions, [
      ["ordinary", 255],
      ["select", 64],
    ]);
  });
  await it("retains source disagreements and refuses wrong native labels", async () => {
    const report = await auditSqlServerVocabulary(
      {
        all: async (sql: string) => {
          const ids = [...sql.matchAll(/\((\d+),N'/gu)].map((match) => Number(match[1]));
          return expectedRows(ids).map((row) => (row.probe_id === 0 ? { ...row, name: "different" } : row));
        },
      },
      17,
      160,
      { facts },
    );
    strict.equal(report.status, "source-mismatch");
    strict.deepEqual(
      report.mismatches.map(({ word, role }: { word: string; role: string }) => [word, role]),
      [["ordinary", "explicit-column"]],
    );
    strict.equal(report.permissions[0]![1], 254);
  });
  await it("falls back only for classified SQL errors and never hides missing protocol records", async () => {
    let described = 0;
    const report = await auditSqlServerVocabulary(
      {
        all: async (sql: string) => {
          if (sql.startsWith("SELECT candidate")) throw { diagnostics: [{ state: "42000", native: 156 }] };
          const text = /describe_first_result_set\(N'((?:''|[^'])*)',NULL,0\)/u.exec(sql)?.[1]?.replaceAll("''", "'");
          const item = cases.find((item: { sql: string }) => item.sql === text)!;
          strict.ok(item);
          described++;
          return [{ error_number: item.expected ? null : 156, column_ordinal: 1, name: item.name }];
        },
      },
      17,
      160,
      { facts },
    );
    strict.equal(report.status, "matched");
    strict.equal(described, 16);
    strict.equal(report.fallbackBatches, 1);
    for (const diagnostics of [[{ state: "08001", native: 0 }], [{ state: "42000", native: 229 }]])
      await strict.rejects(
        auditSqlServerVocabulary(
          {
            all: async () => {
              throw { diagnostics };
            },
          },
          17,
          160,
          { facts },
        ),
      );
    await strict.rejects(auditSqlServerVocabulary({ all: async () => [] }, 17, 160, { facts }), /Missing native/u);
    await strict.rejects(
      auditSqlServerVocabulary({ all: async () => expectedRows([0, 0]) }, 17, 160, { facts }),
      /Duplicate native/u,
    );
    await strict.rejects(
      auditSqlServerVocabulary(
        {
          all: async () => {
            throw Error("must stay cold");
          },
        },
        17,
        180,
        { facts },
      ),
      /Unqualified/u,
    );
  });
  await it("does not turn unavailable native metadata into proof that a reserved spelling is rejected", async () => {
    const report = await auditSqlServerVocabulary(
      {
        all: async (sql: string) => {
          const ids = [...sql.matchAll(/\((\d+),N'/gu)].map((match) => Number(match[1]));
          return expectedRows(ids).map((row) =>
            row.probe_id === 8 ? { ...row, error_number: null, column_ordinal: null, name: null } : row,
          );
        },
      },
      17,
      160,
      { facts },
    );
    strict.equal(report.status, "native-unavailable");
    strict.equal(report.mismatches[0]?.accepted, null);
  });
  await it("discovers every supported engine and compatibility pair in pinned SQL Server evidence", async () => {
    const { SQLSERVER_LANGUAGE_SUPPORT } = await import("../../packages/sqlserver/src/support.js");
    const pins = JSON.parse(
      await readFile(new URL("../../grammar/sqlserver/vocabulary/sources.json", import.meta.url), "utf8"),
    );
    strict.deepEqual(
      pins.profiles.map((profile: { major: number }) => profile.major),
      SQLSERVER_LANGUAGE_SUPPORT.engineMajors,
    );
    for (const profile of pins.profiles)
      strict.deepEqual(
        profile.compatibilityLevels,
        SQLSERVER_LANGUAGE_SUPPORT.compatibilityLevels.filter((level) => level <= profile.major * 10),
      );
    const captured = JSON.parse(
      await readFile(new URL("../../grammar/sqlserver/vocabulary/facts.json", import.meta.url), "utf8"),
    );
    for (const profile of captured.profiles) {
      const words = [...captured.common, ...profile.words];
      const generated = sqlServerVocabularyCases(words);
      strict.equal(generated.length, words.length * 8);
      strict.equal(new Set(generated.map((item: { id: number }) => item.id)).size, generated.length);
    }
  });
});
