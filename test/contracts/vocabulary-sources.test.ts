import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { digest } from "../../scripts/vocabulary/common.mjs";
import { mySqlDescriptorTypes } from "../../scripts/vocabulary/mysql-descriptors.mjs";
import { parseSqliteStandardTypes } from "../../scripts/vocabulary/sqlite-descriptors.mjs";
import { parseSqlServerVocabulary } from "../../scripts/vocabulary/sqlserver.mjs";
import {
  sqlServerDescriptorCases,
  sqlServerDescriptorFailure,
} from "../../scripts/vocabulary/sqlserver-descriptors.mjs";
import { sqlServerNativePermissions } from "../../scripts/vocabulary/sqlserver-policy.mjs";
import { auditSqlServerVocabulary, sqlServerVocabularyCases } from "../../scripts/vocabulary/sqlserver-probes.mjs";
import { reconcileSqlServerVocabulary } from "../../scripts/vocabulary/sqlserver-review.mjs";

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
interface NativeVocabularyRow {
  probe_id: number;
  column_ordinal: number | null;
  error_number: number | null;
  error_type?: number | null;
  name: string | null;
}
const expectedRows = (ids: number[]): NativeVocabularyRow[] =>
  ids.map((id) => ({
    probe_id: id,
    column_ordinal: 1,
    error_number: cases[id]!.expected ? null : 156,
    name: cases[id]!.name,
  }));

await describe("source vocabulary extraction and native audit boundaries", async () => {
  await it("discovers unknown SQL Server catalog types without filtering them through mapped names", () => {
    const row = {
      namespace: "sys",
      name: "future_kind",
      system_type_id: 250,
      user_type_id: 250,
      is_user_defined: false,
      is_assembly_type: false,
    };
    const discovered = sqlServerDescriptorCases([row]);
    strict.equal(discovered.inventory.length, 1);
    strict.deepEqual(
      discovered.cases.filter(({ origin }) => origin === "catalog"),
      [{ origin: "catalog", type: "future_kind", catalog: 0 }],
    );
    const more = sqlServerDescriptorCases([
      row,
      { ...row, name: "opaque_clr", system_type_id: 240, user_type_id: 251, is_assembly_type: true },
    ]);
    strict.equal(more.inventory.length, 2);
    strict.ok(more.cases.some(({ type }) => type === "opaque_clr"));
    for (const input of [
      [],
      [row, row],
      [{ ...row, namespace: "dbo" }],
      [{ ...row, name: "x;drop" }],
      [{ ...row, user_type_id: 0 }],
      [{ ...row, is_user_defined: true }],
    ])
      strict.throws(() => sqlServerDescriptorCases(input));
  });
  await it("retains SQL Server statement diagnostics without swallowing availability or permission failures", () => {
    strict.deepEqual(sqlServerDescriptorFailure({ diagnostics: [{ state: "42000", native: 2715 }] }), {
      status: "rejected",
      numbers: [2715],
    });
    strict.deepEqual(sqlServerDescriptorFailure({ diagnostics: [{ state: "42000", native: 11507 }] }), {
      status: "unavailable",
      numbers: [11507],
    });
    for (const error of [
      new Error("driver unavailable"),
      { diagnostics: [{ state: "08001", native: 2715 }] },
      { diagnostics: [{ state: "HYT00", native: 2715 }] },
      { diagnostics: [{ state: "42000", native: 229 }] },
      { diagnostics: [{ state: "42000", native: 1205 }] },
      { diagnostics: [{ state: "42000", native: 99999 }] },
    ])
      strict.throws(() => sqlServerDescriptorFailure(error));
  });
  await it("derives every MySQL type alternative and discovers new lexical aliases without a type-name list", () => {
    const lex = '{ SYM("ALPHA", ALPHA_SYM) }, { SYM("A_ALIAS", ALPHA_SYM) }, { SYM("BETA", BETA_SYM) }';
    const grammar = `%%
type: head opt_length { this_action_must_not_run(); } | BETA_SYM '(' TEXT_STRING ')' ;
head: ALPHA_SYM | BETA_SYM ;
opt_length: %empty | '(' NUM ')' ;
cast_type: ALPHA_SYM opt_length ;
%%`;
    const facts = mySqlDescriptorTypes(lex, grammar);
    strict.equal(facts.alternatives.length, 3);
    strict.equal(facts.cases.length, 6);
    strict.deepEqual(
      facts.cases.find(({ kind, type }) => kind === "column" && type === "BETA ( 'value' )")?.alternatives,
      ["type:1"],
    );
    const extended = mySqlDescriptorTypes(`${lex}, { SYM("ADDED", ALPHA_SYM) }`, grammar);
    strict.equal(extended.cases.length, facts.cases.length + 2);
    strict.ok(extended.cases.some(({ kind, type }) => kind === "column" && type === "ADDED"));
    strict.throws(() => mySqlDescriptorTypes(lex, grammar.replace("head opt_length", "head UNKNOWN_VALUE")));
    strict.throws(() => mySqlDescriptorTypes(lex, grammar.replace("cast_type:", "different_root:")));
  });
  await it("discovers standard type names from source and rejects truncated or inconsistent tables", () => {
    const source = `
      const unsigned char sqlite3StdTypeLen[] = { 4, 5 };
      const char sqlite3StdTypeAffinity[] = { SQLITE_AFF_BLOB, SQLITE_AFF_INTEGER };
      const char *sqlite3StdType[] = { "FAKE", "OTHER" };
    `;
    strict.deepEqual(parseSqliteStandardTypes(source), [
      { name: "FAKE", affinity: "BLOB" },
      { name: "OTHER", affinity: "INTEGER" },
    ]);
    for (const malformed of [
      source.replace('"OTHER"', '"FAKE"'),
      source.replace("4, 5", "4"),
      source.replace("4, 5", "4, 6"),
      source.replace("4, 5", "4, 2+3"),
      source.replace("SQLITE_AFF_INTEGER", "SQLITE_AFF_INTEGER | 1"),
      source.replace('"FAKE", "OTHER"', '"FAKE", "OTHER", extra()'),
      source + source,
    ])
      strict.throws(() => parseSqliteStandardTypes(malformed));
    strict.deepEqual(parseSqliteStandardTypes(`/* ${source} */ ${source}`), parseSqliteStandardTypes(source));
  });
  await it("requires complete native scopes, pinned producers and every word/context before reconciliation", () => {
    const producerDigest = `sha256:${"0".repeat(64)}`;
    const artifact = {
      major: 17,
      expectedBuild: "17.0.1.1",
      profiles: [
        {
          compatibilityLevel: 160,
          server: { version: "17.0.1.1", compatibility_level: 160 },
          vocabulary: {
            formatVersion: 1,
            status: "source-mismatch",
            major: 17,
            compatibilityLevel: 160,
            sourceDigest: "source",
            wordsDigest: "words",
            toolDigest: producerDigest,
            contexts: cases.slice(0, 8).map((item: { role: string }) => item.role),
            declarations: 2,
            probes: 16,
            permissions: [
              ["ordinary", 255],
              ["select", 255],
            ],
          },
        },
      ],
    };
    const review = (value: typeof artifact, duplicate = false) =>
      reconcileSqlServerVocabulary({
        facts: { ...facts, profiles: [{ ...facts.profiles[0], compatibilityLevels: [160] }] },
        sourceRevision: "0".repeat(40),
        run: "1",
        producerDigest,
        reports: Array.from({ length: duplicate ? 2 : 1 }, () => ({
          file: "catalog-17.json",
          bytes: Buffer.from(JSON.stringify(value)),
        })),
      });
    strict.deepEqual(review(artifact).common, [["select", 255]]);
    const mutations: ((value: typeof artifact) => void)[] = [
      (value) => {
        value.profiles = [];
      },
      (value) => {
        value.profiles[0]!.vocabulary.toolDigest = `sha256:${"1".repeat(64)}`;
      },
      (value) => {
        value.profiles[0]!.vocabulary.status = "native-unavailable";
      },
      (value) => {
        value.profiles[0]!.vocabulary.probes--;
      },
      (value) => {
        value.profiles[0]!.vocabulary.permissions.pop();
      },
      (value) => {
        value.profiles[0]!.vocabulary.permissions[0]![0] = "foreign";
      },
      (value) => {
        value.profiles[0]!.vocabulary.permissions[0]![1] = 0;
      },
      (value) => {
        value.profiles[0]!.server.version = "17.0.2.2";
      },
      (value) => {
        value.profiles[0]!.vocabulary.sourceDigest = "changed";
      },
      (value) => {
        value.profiles[0]!.vocabulary.contexts.reverse();
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(artifact);
      mutate(changed);
      strict.throws(() => review(changed));
    }
    strict.throws(() => review(artifact, true));
  });
  await it("applies reviewed native deltas without hiding original source disagreements", async () => {
    const qualification = {
      formatVersion: 1,
      contexts: cases.slice(0, 8).map((item: { role: string }) => item.role),
      common: [["select", 255]],
      profiles: [
        {
          major: 17,
          compatibilityLevel: 160,
          sourceDigest: "source",
          wordsDigest: "words",
          permissionsDigest: digest(
            JSON.stringify([
              ["ordinary", 255],
              ["select", 255],
            ]),
          ),
          overrides: [],
        },
      ],
    };
    strict.equal(sqlServerNativePermissions(facts, qualification, 17, 160).get("select"), 255);
    const report = await auditSqlServerVocabulary(
      {
        all: async (sql: string) => {
          const ids = [...sql.matchAll(/\((\d+),N'/gu)].map((match) => Number(match[1]));
          return expectedRows(ids).map((row) => ({ ...row, error_number: null }));
        },
      },
      17,
      160,
      { facts, qualification },
    );
    strict.equal(report.status, "matched");
    strict.equal(report.mismatches.length, 0);
    strict.equal(report.sourceMismatches.length, 7);
    strict.match(report.qualificationDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
    for (const changed of [
      { ...qualification, common: [["undeclared", 255]] },
      { ...qualification, common: [["select", -1]] },
      { ...qualification, common: [["select", 64]] },
      { ...qualification, profiles: [{ ...qualification.profiles[0], sourceDigest: "changed" }] },
      { ...qualification, profiles: [{ ...qualification.profiles[0], overrides: [["select", 64]] }] },
    ])
      strict.throws(() => sqlServerNativePermissions(facts, changed, 17, 160));
  });
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
      parseSqlServerVocabulary(common, parser, `${constants}\ninternal const string Dynamic=GetValue();`, 17),
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
    const duplicate = await auditSqlServerVocabulary(
      { all: async () => expectedRows([0, ...cases.map((item: { id: number }) => item.id)]) },
      17,
      160,
      { facts },
    );
    strict.equal(duplicate.status, "native-unavailable");
    strict.equal(duplicate.descriptorFallbacks, 1);
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
  await it("re-describes an ambiguous batch response individually before using its evidence", async () => {
    const report = await auditSqlServerVocabulary(
      {
        all: async (sql: string) => {
          if (sql.startsWith("SELECT candidate")) {
            const ids = [...sql.matchAll(/\((\d+),N'/gu)].map((match) => Number(match[1]));
            return [...expectedRows(ids), ...expectedRows([0])];
          }
          const text = /describe_first_result_set\(N'((?:''|[^'])*)',NULL,0\)/u.exec(sql)?.[1]?.replaceAll("''", "'");
          const item = cases.find((item: { sql: string }) => item.sql === text)!;
          return expectedRows([item.id]);
        },
      },
      17,
      160,
      { facts },
    );
    strict.equal(report.status, "matched");
    strict.equal(report.descriptorFallbacks, 1);
    strict.equal(report.individualDescriptions, 1);
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
  await it("preserves multiple native error records without treating denied metadata as keyword rejection", async () => {
    const client = (denied: boolean) => ({
      all: async (sql: string) => {
        const ids = [...sql.matchAll(/\((\d+),N'/gu)].map((match) => Number(match[1]));
        return expectedRows(ids).flatMap((row) =>
          row.probe_id === 8
            ? [
                { ...row, error_number: denied ? 229 : 102, column_ordinal: null },
                { ...row, error_number: 8180, column_ordinal: null },
              ]
            : [row],
        );
      },
    });
    const described = await auditSqlServerVocabulary(client(false), 17, 160, { facts });
    strict.equal(described.status, "matched");
    const denied = await auditSqlServerVocabulary(client(true), 17, 160, { facts });
    strict.equal(denied.status, "native-unavailable");
    strict.equal(denied.mismatches[0]?.accepted, null);
  });
  await it("keeps native metadata limitations distinct from syntax or binding rejection", async () => {
    const report = await auditSqlServerVocabulary(
      {
        all: async (sql: string) => {
          const ids = [...sql.matchAll(/\((\d+),N'/gu)].map((match) => Number(match[1]));
          return expectedRows(ids).map((row) =>
            row.probe_id === 8 ? { ...row, error_number: 11514, error_type: 4 } : row,
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
