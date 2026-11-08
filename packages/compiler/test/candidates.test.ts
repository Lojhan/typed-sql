import { describe, it, strict } from "poku";
import type { DialectProfile, SchemaSnapshot } from "../../core/src/index.js";
import { postgresProfile } from "../../postgres/src/profile.js";
import { collectSourceQueryCandidates, collectSqlFileQueryCandidates, compileSource } from "../src/index.js";

const profile = postgresProfile(),
  schema = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
const prefix = 'import { sql } from "@typed-sql/postgres";\n';
const source = (query: string) => prefix + query;
const collect = (text: string) => collectSourceQueryCandidates({ source: source(text), profile, schema });

await describe("query acquisition candidates before semantic analysis", async () => {
  await it("uses a lightweight profile and captures unknown functions and syntax without reading an analyzer", () => {
    const isolated = {
      ...profile,
      get analyze(): never {
        throw Error("analyzer loaded");
      },
    };
    const text = source("const q = sql`SELECT vendor_function(${value}::bigint) AS result`;");
    const result = collectSourceQueryCandidates({ source: text, profile: isolated, schema });
    strict.equal(result.complete, true);
    strict.deepEqual(result.diagnostics, []);
    const candidate = result.candidates[0]!;
    strict.equal(candidate.sql, "SELECT vendor_function($1::bigint) AS result");
    strict.deepEqual(candidate.parameterOccurrences, [{ index: 1, start: 23, end: 25 }]);
    strict.deepEqual(candidate.logicalBindings, [0]);
    strict.equal(candidate.logicalParameterCount, 1);
    strict.equal(candidate.sqlOffsetMap[candidate.parameterOccurrences[0]!.start], text.indexOf("${value}"));
    strict.equal(collect("sql`VENDOR SYNTAX SELECT 1`;").complete, true);
    strict.ok(Object.isFrozen(candidate));
    strict.ok(Object.isFrozen(candidate.parameterOccurrences[0]));
    strict.ok(Object.isFrozen(candidate.sqlOffsetMap));
    strict.ok(Object.isFrozen(result.candidates));
  });
  await it("expands every finite conditional variant with source positions, renumbered binds and hashed branch identities", () => {
    const result = collect(
      "const q = sql`SELECT 1 ${enabled ? sql.fragment`WHERE id = ${id}` : sql.empty} ${other ? sql.fragment`ORDER BY vendor(${order})` : sql.empty}`;",
    );
    strict.equal(result.complete, true);
    strict.equal(result.candidates.length, 4);
    strict.deepEqual([...new Set(result.candidates.map((item) => item.parameterOccurrences.length))].sort(), [0, 1, 2]);
    strict.equal(new Set(result.candidates.map((item) => item.sql)).size, 4);
    for (const item of result.candidates) {
      strict.equal(Object.keys(item.choices).length, 2);
      strict.ok(Object.keys(item.choices).every((key) => /^[a-f0-9]{64}$/u.test(key)));
      strict.deepEqual(
        item.parameterOccurrences.map((value) => value.index),
        item.logicalBindings.map((_, index) => index + 1),
      );
    }
    const moved = collectSourceQueryCandidates({
      source:
        "\n" +
        source(
          "const q = sql`SELECT 1 ${enabled ? sql.fragment`WHERE id = ${id}` : sql.empty} ${other ? sql.fragment`ORDER BY vendor(${order})` : sql.empty}`;",
        ),
      profile,
      schema,
    });
    strict.deepEqual(
      moved.candidates.map((item) => [item.sql, item.choices]),
      result.candidates.map((item) => [item.sql, item.choices]),
    );
    strict.ok(moved.candidates[0]!.sourceRange.start > result.candidates[0]!.sourceRange.start);
  });
  await it("does not certify correlated branch coverage for repeated calls or getters", () => {
    for (const condition of ["nextFlag()", "state.enabled"]) {
      const text = source(
        "sql`SELECT 1 ${" +
          condition +
          " ? sql.fragment`AS one` : sql.empty} ${" +
          condition +
          " ? sql.fragment`WHERE TRUE` : sql.empty}`;",
      );
      const result = collectSourceQueryCandidates({ source: text, profile, schema });
      strict.equal(result.complete, false);
      strict.equal(result.candidates.length, 0);
      strict.equal(result.diagnostics[0]!.code, "TSQ016");
    }
    const stable = collect(
      "sql`SELECT 1 ${enabled ? sql.fragment`AS one` : sql.empty} ${enabled ? sql.fragment`WHERE TRUE` : sql.empty}`;",
    );
    strict.equal(stable.complete, true);
    strict.equal(stable.candidates.length, 2);
  });
  await it("tracks nested physical bindings across multi-digit renumbering and tuple expansion", () => {
    const parameters = Array.from({ length: 9 }, (_, index) => `\${p${index}}`).join(", ");
    const text = source(
      "sql`SELECT " +
        parameters +
        ", ${enabled ? sql.fragment`vendor(${ten}::bigint), vendor(${eleven}::bigint)` : sql.fragment`0`}`;",
    );
    const result = collectSourceQueryCandidates({ source: text, profile, schema });
    strict.equal(result.complete, true);
    const full = result.candidates.find((item) => item.parameterOccurrences.length === 11)!;
    strict.ok(full);
    for (const occurrence of full.parameterOccurrences)
      strict.equal(full.sql.slice(occurrence.start, occurrence.end), profile.placeholder(occurrence.index));
    strict.equal(full.sqlOffsetMap[full.parameterOccurrences[9]!.start], text.indexOf("${ten}"));
    strict.equal(full.sqlOffsetMap[full.parameterOccurrences[10]!.start], text.indexOf("${eleven}"));
    const tuple = collect(
      "sql`SELECT ${first}, ${[sql.fragment`vendor(${second})`, sql.fragment`vendor(${third})`]}, ${last}`;",
    );
    strict.equal(tuple.complete, true);
    strict.deepEqual(
      tuple.candidates[0]!.parameterOccurrences.map((item) => item.index),
      [1, 2, 3, 4],
    );
  });
  await it("collects full append compositions before requiring a resolved base row", () => {
    const result = collect(
      "const base = sql`SELECT vendor_function(${id}::bigint) AS result`; const q = sql.append(base, sql.fragment` WHERE ${flag}::boolean`);",
    );
    strict.equal(result.complete, true);
    strict.ok(
      result.candidates.some(
        (item) => item.kind === "template" && item.sql === "SELECT vendor_function($1::bigint) AS result",
      ),
    );
    strict.ok(
      result.candidates.some(
        (item) =>
          item.kind === "composition" && item.sql === "SELECT vendor_function($1::bigint) AS result WHERE $2::boolean",
      ),
    );
    strict.equal(collect("const base = sql`SELECT 1`; sql.append(base, fragmentFromElsewhere);").complete, false);
  });
  await it("expands fixed fragment tuples and reports runtime-sized lists as unsupported instead of describing a representative", () => {
    const fixed = collect(
      "sql`SELECT ${[sql.fragment`vendor(${first}::bigint) AS a`, sql.fragment`vendor(${second}::bigint) AS b`]}`;",
    );
    strict.equal(fixed.complete, true);
    strict.equal(fixed.candidates.length, 1);
    strict.equal(fixed.candidates[0]!.sql, "SELECT vendor($1::bigint) AS a, vendor($2::bigint) AS b");
    const repeated = collect("sql`SELECT ${items.map((item) => sql.fragment`vendor(${item}::bigint) AS value`)}`;");
    strict.equal(repeated.complete, false);
    strict.equal(repeated.candidates.length, 0);
    strict.equal(repeated.diagnostics[0]!.code, "TSQ013");
    strict.equal(collect("sql`SELECT ${[]}`;").diagnostics[0]!.code, "TSQ008");
  });
  await it("never treats explicit unrendered structure as a parameter or evaluates source expressions", () => {
    for (const text of [
      'sql`SELECT ${sql.ident("id")}::text`;',
      'sql`SELECT ${sql.raw("1")}::text`;',
      'sql`SELECT ${sql["raw"]("1")}`;',
      "sql`SELECT ${sql`SELECT 1`}`;",
    ]) {
      const result = collect(text);
      strict.equal(result.complete, false);
      strict.equal(result.candidates.length, 0);
      strict.equal(result.diagnostics[0]!.code, "TSQ016");
    }
    const quoted = collect('sql`SELECT ${"sql.raw(ignored)"}::text`;');
    strict.equal(quoted.complete, true);
    strict.equal(quoted.candidates[0]!.sql, "SELECT $1::text");
    strict.equal(collect('sql`SELECT ${(() => { throw new Error("must not execute"); })()}::text`;').complete, true);
    strict.equal(collect("sql.dynamic(userSql);").diagnostics[0]!.code, "TSQ005");
    strict.equal(
      collect("const q = sql`SELECT 1 ${enabled ? `WHERE id = ${id}` : sql.empty}`;").diagnostics[0]!.code,
      "TSQ004",
    );
  });
  await it("requires exact lexical binding correspondence and rejects literal or quoted placeholder ambiguity", () => {
    for (const text of ["sql`SELECT $1`;", "sql`SELECT $1, ${id}`;", "sql`SELECT '${id}'`;"]) {
      strict.equal(collect(text).complete, false);
      strict.equal(collect(text).candidates.length, 0);
    }
    const { parameterOccurrences: _, ...missingHook } = profile;
    strict.equal(
      collectSourceQueryCandidates({ source: source("sql`SELECT 1`;"), profile: missingHook, schema }).diagnostics[0]!
        .code,
      "TSQ901",
    );
    const range = { start: 7, end: 9, line: 1, column: 8 };
    for (const occurrences of [
      [{ index: 1, range: { ...range, start: -1 } }],
      [{ index: 1, range: { ...range, end: 100 } }],
      [{ index: 2, range }],
      [{ index: 1, range: { ...range, end: 8 } }],
    ]) {
      strict.equal(
        collectSourceQueryCandidates({
          source: source("sql`SELECT ${value}`;"),
          profile: { ...profile, parameterOccurrences: () => occurrences },
          schema,
        }).complete,
        false,
      );
    }
    strict.equal(
      collectSourceQueryCandidates({
        source: source("sql`SELECT 1`;"),
        profile: {
          ...profile,
          parameterOccurrences: () => {
            throw Error("invalid lexer");
          },
        },
        schema,
      }).complete,
      false,
    );
    strict.equal(collect("sql``;").complete, false);
  });
  await it("bounds source, query, variant, rendered byte and candidate counts without exporting a partial resource-limited set", () => {
    const text = source("sql`SELECT 1`; sql`SELECT 2`;");
    for (const limits of [{ maxSourceBytes: 1 }, { maxQueries: 1 }, { maxCandidates: 1 }, { maxRenderedSqlBytes: 1 }]) {
      const result = collectSourceQueryCandidates({ source: text, profile, schema, ...limits });
      strict.equal(result.complete, false);
      strict.equal(result.candidates.length, 0);
      strict.equal(result.diagnostics[0]!.code, "TSQ006");
    }
    const compositions = collectSourceQueryCandidates({
      source: source("const base = sql`SELECT 1`; sql.append(base, value); sql.append(base, other);"),
      profile,
      schema,
      maxCandidates: 1,
    });
    strict.equal(compositions.complete, false);
    strict.equal(compositions.candidates.length, 0);
    strict.equal(compositions.diagnostics[0]!.code, "TSQ006");
    const dynamic = collectSourceQueryCandidates({
      source: source("sql.dynamic(one); sql.dynamic(two); sql.dynamic(three);"),
      profile,
      schema,
      maxQueries: 1,
    });
    strict.equal(dynamic.complete, false);
    strict.equal(dynamic.diagnostics[0]!.code, "TSQ006");
    const variant = collectSourceQueryCandidates({
      source: source("sql`SELECT 1 ${a ? sql.fragment`WHERE TRUE` : sql.empty}`;"),
      profile,
      schema,
      maxStructuralVariants: 1,
    });
    strict.equal(variant.complete, false);
    strict.equal(variant.diagnostics[0]!.code, "TSQ003");
    strict.throws(() => collectSourceQueryCandidates({ source: text, profile, schema, maxCandidates: 0 }), /positive/u);
    strict.throws(
      () =>
        collectSourceQueryCandidates({
          source: text,
          profile,
          schema: { ...schema, dialect: "other" } as unknown as typeof schema,
        }),
      /Dialect/u,
    );
    strict.equal(collect('const text = "sql`SELECT 1`";').candidates.length, 0);
  });
  await it("uses profile-owned anonymous placeholder rules without selecting a grammar by name", () => {
    const generic: DialectProfile<SchemaSnapshot, unknown> = {
      ...profile,
      id: "vendor/anonymous",
      sqlModule: "vendor/anonymous",
      runtimeSqlModule: "vendor/anonymous/runtime",
      placeholder: () => "?",
      parameterOccurrences: (sql) =>
        [...sql.matchAll(/\?/gu)].map((match, index) => ({
          index: index + 1,
          range: { start: match.index, end: match.index + 1, line: 1, column: match.index + 1 },
        })),
      validateSnapshot: (value) => value as SchemaSnapshot,
    };
    const result = collectSourceQueryCandidates({
      source: 'import {sql as q} from "vendor/anonymous"; q`SELECT ${one}, ${two}`;',
      profile: generic,
      schema: { ...schema, dialect: generic.id },
    });
    strict.equal(result.complete, true);
    strict.equal(result.candidates[0]!.sql, "SELECT ?, ?");
    strict.deepEqual(result.candidates[0]!.logicalBindings, [0, 1]);
  });
});

await describe("SQL asset candidate preparation", async () => {
  await it("preserves repeated/reordered logical bindings while emitting the same normalized SQL as factories", async () => {
    const { postgres } = await import("../../postgres/src/index.js");
    const samples = [
      "SELECT vendor($2::bigint), vendor($1::bigint), vendor($2::bigint)",
      "SELECT vendor(:id::bigint), ':ignored' AS label, vendor(:id::bigint) -- :ignored\n",
    ];
    for (const text of samples) {
      const result = collectSqlFileQueryCandidates({ source: text, profile, schema });
      strict.equal(result.complete, true);
      strict.equal(result.candidates.length, 1);
      const candidate = result.candidates[0]!;
      strict.deepEqual(candidate.logicalBindings, text.includes(":id") ? [0, 0] : [1, 0, 1]);
      strict.deepEqual(
        candidate.parameterOccurrences.map((item) => item.index),
        text.includes(":id") ? [1, 2] : [1, 2, 3],
      );
      strict.equal(candidate.logicalParameterCount, text.includes(":id") ? 1 : 2);
      for (const occurrence of candidate.parameterOccurrences)
        strict.equal(text[candidate.sqlOffsetMap[occurrence.start]!], text.includes(":id") ? ":" : "$");
      // Unknown vendor functions still fail semantic analysis independently of successful collection.
      strict.ok(
        postgres()
          .analyze(candidate.sql, schema)
          .diagnostics.some((item) => item.severity === "error"),
      );
    }
    const text = "SELECT $2::bigint AS a, $1::bigint AS b, $2::bigint AS c";
    const collected = collectSqlFileQueryCandidates({ source: text, profile, schema });
    const { compileSqlFile } = await import("../src/index.js");
    strict.equal(
      compileSqlFile({ source: text, dialect: postgres(), schema }).query!.variants[0]!.sql,
      collected.candidates[0]!.sql,
    );
  });
  await it("reports incomplete SQL assets without invoking semantics or silently dropping malformed bindings", () => {
    for (const text of ["SELECT $2", "SELECT :id, $1", ""]) {
      const result = collectSqlFileQueryCandidates({ source: text, profile, schema });
      strict.equal(result.complete, false);
      strict.equal(result.candidates.length, 0);
    }
    strict.equal(
      collectSqlFileQueryCandidates({ source: "SELECT 1", profile, schema, maxSourceBytes: 1 }).complete,
      false,
    );
    const { runtimeSqlModule: _, ...noRuntime } = profile;
    strict.equal(collectSqlFileQueryCandidates({ source: "SELECT 1", profile: noRuntime, schema }).complete, false);
  });
  await it("keeps ordinary compilation on the same finite rendering path", async () => {
    const { postgres } = await import("../../postgres/src/index.js");
    const text = source(
      "const q = sql`SELECT 1 AS value ${enabled ? sql.fragment`WHERE ${flag}::boolean` : sql.empty}`;",
    );
    const collected = collectSourceQueryCandidates({ source: text, profile, schema });
    const compiled = compileSource({ source: text, dialect: postgres(), schema });
    strict.deepEqual(compiled.diagnostics, []);
    strict.deepEqual(
      compiled.queries[0]!.variants.map((item) => item.sql),
      collected.candidates.map((item) => item.sql),
    );
    const unsafe = compileSource({
      source: source('sql`SELECT ${sql.ident("id")}::text`;'),
      dialect: postgres(),
      schema,
    });
    strict.equal(unsafe.diagnostics[0]!.code, "TSQ016");
    strict.equal(unsafe.queries.length, 0);
  });
});
