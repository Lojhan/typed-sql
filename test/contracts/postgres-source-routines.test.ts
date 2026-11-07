import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { expandTarget, readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { postgresSemanticSignature } from "../../tools/grammar-catalog/src/generate/facts/postgres-semantic.mjs";
import { postgresMapper } from "../../tools/grammar-catalog/src/mappers/postgres.mjs";
import { describeRoutine } from "../../tools/grammar-catalog/src/model/build.mjs";
import { checkSourceTexts, readLockedSources } from "../../tools/grammar-catalog/src/sources/postgres/facts.mjs";
import { grammarTypeAliases } from "../../tools/grammar-catalog/src/sources/postgres/grammar-aliases.mjs";
import {
  catalogArray,
  prepareSourceProfile,
  sourceRoutineRow,
} from "../../tools/grammar-catalog/src/sources/postgres/model.mjs";
import { installationHeaders } from "../../tools/grammar-catalog/src/sources/postgres/sql-headers.mjs";

const { facts, lock } = await readLockedSources(fileURLToPath(new URL("../../", import.meta.url)));
const corpus = await readCorpus();

await describe("PostgreSQL source routine interpretation", async () => {
  await it("binds interpreted source text to the declared archive member", () => {
    const version = Object.keys(facts.versions)[0]!,
      source = facts.versions[version]!;
    const changed = {
      ...facts,
      versions: {
        ...facts.versions,
        [version]: {
          ...source,
          textInputs: { ...source.textInputs, "src/backend/catalog/system_functions.sql": source.licenseNotice },
        },
      },
    };
    strict.throws(() => checkSourceTexts(lock, changed), /source text bytes disagree/u);
  });
  await it("projects every bootstrap routine through validated source facts with equal native runtime signatures", () => {
    for (const target of Object.values(corpus.targets)) {
      if (typeof target !== "object" || target === null || !("dialect" in target) || target.dialect !== "postgres")
        continue;
      const capture = expandTarget(corpus, target),
        version = /^(\d+(?:\.\d+|beta\d+))/u.exec(capture.target.version)![1]!;
      const source = facts.versions[version]!;
      const prepared = prepareSourceProfile(facts, source, capture);
      strict.equal(prepared.routines.size, source.catalogs.pg_proc!.entries.length);
      strict.deepEqual(prepared.comparison.mismatches, []);
      strict.deepEqual(prepared.comparison.installationGaps, []);
      strict.equal(
        prepared.comparison.nativeOnly.length + prepared.routines.size,
        capture.categories.functions.rows.length,
      );
      for (const row of capture.categories.functions.rows) {
        const routine = prepared.routines.get(row.identity);
        if (!routine) continue;
        strict.deepEqual(
          postgresSemanticSignature({ name: row.name, routine }),
          postgresSemanticSignature({ name: row.name, routine: describeRoutine(row.signature, postgresMapper) }),
        );
        strict.equal(routine.result.nullable.status, "unknown");
        strict.ok(routine.requiredPolicy.includes("decoding"));
      }
      const identity = prepared.comparison.matched[0]!.identity;
      const changed = {
        ...capture,
        categories: {
          ...capture.categories,
          functions: {
            ...capture.categories.functions,
            rows: capture.categories.functions.rows.map((row: { identity: string; strict: boolean }) =>
              row.identity === identity ? { ...row, strict: !row.strict } : row,
            ),
          },
        },
      };
      strict.throws(() => prepareSourceProfile(facts, source, changed), /Unqualified/u);
    }
  });

  await it("decodes catalog array whitespace, quoted values and escaped NULL spellings", () => {
    strict.deepEqual(catalogArray('{first, second ," x ",NULL,"NULL",N\\ULL}'), [
      "first",
      "second",
      " x ",
      null,
      "NULL",
      "NULL",
    ]);
    strict.deepEqual(catalogArray('{"a,b","a\\"b",\\ padded\\ }'), ["a,b", 'a"b', " padded "]);
    strict.deepEqual(catalogArray("{ }"), []);
    strict.equal(catalogArray("_null_"), null);
    for (const value of ['{"unclosed}', "{nested,{x}}", "{a,}", "{a,,b}"]) strict.throws(() => catalogArray(value));
  });

  await it("extracts parameter headers without interpreting body strings or comments as declarations", () => {
    const types = new Map([
      ["int4", "integer"],
      ["text", "text"],
    ]);
    const sql =
      '/* CREATE FUNCTION fake() */ CREATE OR REPLACE FUNCTION pg_catalog."Mixed"(IN "arg" integer DEFAULT (coalesce(1,2)), OUT value text) RETURNS record LANGUAGE SQL AS $$CREATE FUNCTION fake()$$;';
    const parsed = installationHeaders(sql, types);
    strict.deepEqual(parsed.gaps, []);
    strict.equal(parsed.headers.length, 1);
    strict.equal(parsed.headers[0]!.name, "Mixed");
    strict.equal(parsed.headers[0]!.parameters[0]!.default, "(coalesce(1,2))");
    strict.equal(parsed.headers[0]!.parameters[1]!.mode, "o");
    const escaped = String.raw`E'it\'s, (safe)'`;
    const escapeHeader = installationHeaders(
      `CREATE FUNCTION escapes(x text DEFAULT ${escaped}) RETURNS text LANGUAGE SQL RETURN x;`,
      types,
    );
    strict.deepEqual(escapeHeader.gaps, []);
    strict.equal(escapeHeader.headers[0]!.parameters[0]!.default, escaped);
    strict.equal(
      installationHeaders("CREATE FUNCTION fresh(x unsupported) RETURNS text LANGUAGE SQL RETURN x;", types).gaps
        .length,
      1,
    );
    strict.throws(() => installationHeaders("/* unclosed", types), /Unclosed/u);
  });

  await it("derives only unconditional type aliases from grammar actions and ignores comments/literals", () => {
    const keywords = [
      { token: "INT_P", name: "int" },
      { token: "FLOAT_P", name: "float" },
    ];
    const types = new Map([
      ["int4", "integer"],
      ["float4", "real"],
      ["float8", "double precision"],
    ]);
    const grammar =
      '/* 😀 INT_P { $$ = SystemTypeName("float4"); } */ Numeric: INT_P { $$ = SystemTypeName("int4"); } | FLOAT_P { $$ = SystemTypeName("float8"); if (x) $$ = SystemTypeName("float4"); }';
    strict.deepEqual([...grammarTypeAliases(grammar, keywords, types)], [["int", "integer"]]);
    strict.throws(
      () => grammarTypeAliases('Numeric: INT_P { $$ = SystemTypeName("int4");', keywords, types),
      /Unclosed/u,
    );
  });

  await it("rejects unfamiliar source modes and malformed default constants", () => {
    const source = Object.values(facts.versions)[0]!;
    const row = facts.rows[source.catalogs.pg_proc!.entries[0]!.row]!;
    const types = new Map([
      ["cstring", "cstring"],
      ["bool", "boolean"],
    ]);
    strict.throws(
      () => sourceRoutineRow({ ...row, proargmodes: "{future}" }, types, source.keywords),
      /parameter mode/u,
    );
    strict.throws(
      () => sourceRoutineRow({ ...row, proargdefaults: "unrecognized" }, types, source.keywords),
      /catalog array/u,
    );
  });
});
