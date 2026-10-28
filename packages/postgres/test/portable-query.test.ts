import { it, strict } from "poku";
import { assertRuntimeAdapterConformance } from "../../conformance/src/index.js";
import { normalizePostgresValue, postgresRenderer, postgresRuntimeValueType, sql } from "../src/query.js";

await it("keeps the portable PostgreSQL entrypoint compatible with the core buffered contract", async () => {
  await assertRuntimeAdapterConformance({
    name: "postgres/query",
    renderer: postgresRenderer,
    query: sql`SELECT ${7} AS n`,
    expectedText: "SELECT $1 AS n",
    expectedValues: [7],
    rows: [{ n: 7 }],
  });
  for (const [tsType, expected] of [
    ["number", "number"],
    ["bigint", "bigint"],
    ["boolean", "boolean"],
    ["string", "string"],
    ["Date", "date"],
    ["Uint8Array", "bytes"],
    ["Custom", "unknown"],
  ] as const)
    strict.deepEqual(postgresRuntimeValueType({ tsType, nullable: false }), expected);
  strict.deepEqual(postgresRuntimeValueType({ databaseType: "bigint[][]", tsType: "ignored", nullable: false }), {
    array: { array: "bigint" },
  });
  strict.equal(normalizePostgresValue("9223372036854775807", "bigint"), 9_223_372_036_854_775_807n);
  strict.equal(normalizePostgresValue("1.25", "number"), 1.25);
  strict.equal(normalizePostgresValue("t", "boolean"), true);
  strict.equal(normalizePostgresValue("f", "boolean"), false);
  strict.equal(normalizePostgresValue("not a bool", "boolean"), "not a bool");
  strict.ok(normalizePostgresValue("2026-01-02", "date") instanceof Date);
  strict.deepEqual(normalizePostgresValue("\\x00ff", "bytes"), Uint8Array.of(0, 255));
  strict.deepEqual(normalizePostgresValue('{"a,b","NULL",NULL,"a\\"b"}', { array: "string" }), [
    "a,b",
    "NULL",
    null,
    'a"b',
  ]);
  strict.deepEqual(normalizePostgresValue("[2:3]={{1,NULL},{2,3}}", { array: { array: "bigint" } }), [
    [1n, null],
    [2n, 3n],
  ]);
  strict.deepEqual(normalizePostgresValue("{}", { array: "number" }), []);
  strict.deepEqual(normalizePostgresValue(["t", null], { array: "boolean" }), [true, null]);
  for (const invalid of ["bad", "1.2"]) strict.throws(() => normalizePostgresValue(invalid, "bigint"));
  for (const invalid of ["bad", "NaN", "9007199254740993"])
    strict.throws(() => normalizePostgresValue(invalid, "number"));
  strict.throws(() => normalizePostgresValue("\\x0", "bytes"));
  for (const invalid of ["bad", "{", '{"unclosed}', "{a,}", "{a}tail"])
    strict.throws(() => normalizePostgresValue(invalid, { array: "string" }));
});
