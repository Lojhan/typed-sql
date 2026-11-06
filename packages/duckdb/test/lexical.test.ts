import { it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { parseDuckDBStatement } from "../src/parser/parser.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`matches escape/dollar strings and UTF-16 marker ranges on genuine ${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const snapshot = {
    formatVersion: 1 as const,
    dialect: "duckdb" as const,
    server: fixtureEvidence(version),
    tables: {},
  };
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  try {
    for (const literal of [
      String.raw`E'\b'`,
      String.raw`E'\f'`,
      String.raw`E'\n\r\t'`,
      String.raw`E'\v\a\z'`,
      String.raw`E'\x41'`,
      String.raw`E'\x4'`,
      ...(version === "2.0.0" ? [String.raw`E'\xc3\xa9'`, String.raw`E'\u263a'`, String.raw`E'\U0001F600'`] : []),
      String.raw`E'\101'`,
      String.raw`E'\x'`,
      String.raw`E'it\'s'`,
      "E'it''s😀'",
      "$$it's :not $1 ?$$",
      "$tag$😀 $1$tag$",
    ]) {
      const query = `SELECT ${literal}`,
        native = await connection.run(query);
      try {
        const analysis = duckdb().analyze(query, snapshot),
          parsed = parseDuckDBStatement(query).projections[0]!.expression;
        strict.deepEqual(analysis.diagnostics, [], literal);
        strict.equal(analysis.columns[0]?.name, native.columnName(0), literal);
        strict.equal(JSON.parse(parsed.value!), (await native.getRows())[0]?.[0], literal);
        strict.deepEqual(duckdb().parameterOccurrences?.(query, snapshot), []);
      } finally {
        native.closeSync();
      }
    }
    if (version === "1.5.6")
      for (const literal of [String.raw`E'\xc3\xa9'`, String.raw`E'\u263a'`, String.raw`E'\U0001F600'`]) {
        await strict.rejects(connection.prepare(`SELECT ${literal}`));
        strict.equal(duckdb().analyze(`SELECT ${literal}`, snapshot).diagnostics[0]?.code, "TSQ401");
      }
    const query = "SELECT /* nested /* $9 */ :bad */ E'😀' AS text,\n $1::BIGINT AS value -- $2";
    const markers = duckdb().parameterOccurrences?.(query, snapshot);
    strict.equal(markers?.[0]?.range.start, query.indexOf("$1"));
    strict.equal(markers?.[0]?.range.end, query.indexOf("$1") + 2);
    strict.equal(markers?.[0]?.range.line, 2);
    strict.equal(markers?.[0]?.range.column, 2);
    strict.equal(markers?.length, 1);
    for (const literal of [
      String.raw`E'\0'`,
      String.raw`E'\x00'`,
      String.raw`E'\400'`,
      String.raw`E'\xff'`,
      String.raw`E'\xc3'`,
    ]) {
      const query = `SELECT ${literal}`;
      await strict.rejects(connection.prepare(query));
      strict.ok(duckdb().analyze(query, snapshot).diagnostics.length, literal);
    }
    strict.ok(duckdb().analyze("SELECT E'abc\\", snapshot).diagnostics.length);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
