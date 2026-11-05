import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { compileSqlFile } from "../../compiler/src/index.js";
import type { DialectPlugin, SchemaSnapshot } from "../../core/src/index.js";
import { duckDBServerEvidence, duckdb } from "../../duckdb/src/browser.js";
import { sqlServerServerEvidence, sqlserver } from "../../sqlserver/src/browser.js";
import { parseGrammarFeatureLedger } from "../src/index.js";

const duckSnapshot = {
  formatVersion: 1 as const,
  dialect: "duckdb",
  server: duckDBServerEvidence("2.0.0", [], {
    Calendar: "gregorian",
    integer_division: "false",
    preserve_identifier_case: "preserve_case",
  }),
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "BIGINT", tsType: "bigint", nullable: false },
        name: { name: "name", databaseType: "VARCHAR", tsType: "string", nullable: false },
      },
    },
  },
};
const sqlSnapshot = {
  formatVersion: 1 as const,
  dialect: "sqlserver",
  server: sqlServerServerEvidence("17.0.5035.5", {
    compatibilityLevel: 170,
    collation: "Latin1_General_100_CI_AS",
    defaultSchema: "dbo",
    quotedIdentifier: true,
    ansiWarnings: true,
    arithAbort: true,
    concatNullYieldsNull: true,
    dateFirst: 7,
    dateFormat: "mdy",
    language: "us_english",
  }),
  tables: {
    users: {
      name: "users",
      schema: "dbo",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        name: { name: "name", databaseType: "nvarchar(40)", tsType: "string", nullable: false },
      },
    },
  },
};
const grammars: readonly { dialect: DialectPlugin; snapshot: SchemaSnapshot }[] = [
  { dialect: duckdb(), snapshot: duckSnapshot },
  { dialect: sqlserver(), snapshot: sqlSnapshot },
];
// Distinct vendor syntax is intentionally kept separate: T-SQL OUTPUT is not
// RETURNING, OPENJSON is not JSON_TABLE, and DuckDB JSON functions are not the
// PostgreSQL SQL/JSON clause language.
const rejected: Readonly<Record<string, string>> = {
  "expression.aggregate.filter": "SELECT count(*) FILTER(WHERE id>0) AS value FROM users",
  "expression.aggregate.within-group": "SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY id) AS value FROM users",
  "expression.array.constructor": "SELECT ARRAY[1,2] AS value",
  "expression.array.subscript": "SELECT (ARRAY[1,2])[1] AS value",
  "expression.at-local": "SELECT CURRENT_TIMESTAMP AT LOCAL AS value",
  "expression.at-time-zone": "SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS value",
  "expression.collate": "SELECT 'x' COLLATE nocase AS value",
  "expression.composite-field": "SELECT (ROW(1)).field AS value",
  "expression.interval-literal": "SELECT INTERVAL '1 day' AS value",
  "expression.json-path": "SELECT '$.a'::jsonpath AS value",
  "expression.quantified-comparison": "SELECT CASE WHEN 1=ANY(SELECT id FROM users) THEN 1 ELSE 0 END AS value",
  "expression.row-comparison": "SELECT CASE WHEN (1,2)=(1,2) THEN 1 ELSE 0 END AS value",
  "expression.sql-json-aggregates": "SELECT JSON_ARRAYAGG(id RETURNING jsonb) AS value FROM users",
  "expression.sql-json-constructors": "SELECT JSON_OBJECT(KEY 'a' VALUE 1 RETURNING jsonb) AS value",
  "expression.sql-json-conversion": "SELECT JSON_SCALAR(1 RETURNING jsonb) AS value",
  "expression.sql-json-exists": "SELECT JSON_EXISTS('{}','$' TRUE ON ERROR) AS value",
  "expression.sql-json-predicate": "SELECT '{}' IS JSON OBJECT AS value",
  "expression.sql-json-query": "SELECT JSON_QUERY('{}','$' RETURNING jsonb WITH WRAPPER) AS value",
  "expression.sql-json-value": "SELECT JSON_VALUE('{}','$' RETURNING integer DEFAULT 1 ON ERROR) AS value",
  "query.distinct-on": "SELECT DISTINCT ON(id) id FROM users",
  "query.locking.read": "SELECT id FROM users FOR UPDATE",
  "query.relation.derived-alias-optional": "SELECT id FROM (SELECT id FROM users)",
  "query.relation.json-table": "SELECT * FROM JSON_TABLE('{}','$' COLUMNS(id integer PATH '$.id')) AS t",
  "query.relation.lateral": "SELECT a.id FROM users a,LATERAL(SELECT a.id) AS b",
  "query.relation.rows-from": "SELECT * FROM ROWS FROM(generate_series(1,2)) AS t",
  "query.relation.table-sample": "SELECT id FROM users TABLESAMPLE SYSTEM(10)",
  "query.with.search-cycle": "WITH RECURSIVE t(id) AS(SELECT 1) SEARCH DEPTH FIRST BY id SET position SELECT id FROM t",
  "statement.cte.data-modifying": "WITH t AS(DELETE FROM users OUTPUT deleted.id) SELECT id FROM t",
  "statement.dml.delete-using": "DELETE FROM users USING users AS other WHERE users.id=other.id",
  "statement.dml.positioned-update-delete": "DELETE FROM users WHERE CURRENT OF cursor_name",
  "statement.dml.returning": "DELETE FROM users RETURNING id",
  "statement.dml.returning-old-new": "UPDATE users SET name='x' RETURNING WITH(OLD AS o,NEW AS n) o.id,n.id",
  "statement.insert.conflict": "INSERT INTO users(id,name) VALUES(1,'x') ON CONFLICT(id) DO NOTHING",
  "statement.insert.identity-overriding": "INSERT INTO users(id,name) OVERRIDING SYSTEM VALUE VALUES(1,'x')",
  "statement.merge": "MERGE INTO users AS t USING users AS s ON t.id=s.id WHEN MATCHED THEN DELETE",
  "statement.replace": "REPLACE INTO users(id,name) VALUES(1,'x')",
  "type.duckdb.variant": "SELECT CAST(NULL AS VARIANT) AS value",
};

await describe("native grammar feature-ledger evidence", async () => {
  const ledger = parseGrammarFeatureLedger(
    JSON.parse(await readFile(new URL("../../../grammar/features/ledger.json", import.meta.url), "utf8")) as unknown,
  );
  await it("fails closed for every native unsupported syntax classification cited here", () => {
    const optimistic: string[] = [];
    for (const { dialect, snapshot } of grammars) {
      for (const entry of ledger.entries) {
        const support = entry.dialects[dialect.id]!;
        if (
          support.level !== "unsupported" ||
          !support.tests.includes("packages/conformance/test/native-feature-ledger.test.ts")
        )
          continue;
        const source = rejected[entry.id];
        strict.ok(source, `${entry.id}.${dialect.id} needs a concrete rejection witness`);
        const analysis = dialect.analyze(source!, snapshot);
        if (!analysis.diagnostics.length && !analysis.columns.every((column) => column.tsType === "unknown"))
          optimistic.push(`${entry.id}.${dialect.id}: ${source}`);
        for (const diagnostic of analysis.diagnostics) {
          strict.ok(diagnostic.range.start >= 0 && diagnostic.range.end <= source!.length);
          strict.ok(diagnostic.range.end >= diagnostic.range.start);
        }
        strict.ok(!analysis.columns.some((column) => /\bany\b/u.test(column.tsType)));
      }
    }
    strict.deepEqual(optimistic, [], "Unsupported syntax cannot receive an optimistic type");
  });
  await it("separates VARIANT capability diagnostics from conservative cast analysis", () => {
    const dialect = duckdb();
    strict.equal(dialect.resolveCapabilities!(duckSnapshot).variant?.diagnostic, "TSQ401");
    const analysis = dialect.analyze("SELECT CAST(1 AS VARIANT) AS value", duckSnapshot);
    strict.ok(analysis.diagnostics.length > 0 || analysis.columns[0]?.tsType === "unknown");
  });
  await it("retains conservative unknown functions and rejects procedural batches", () => {
    for (const { dialect, snapshot } of grammars) {
      const future = dialect.analyze("SELECT future_unregistered_function(id) AS value FROM users", snapshot);
      strict.ok(future.diagnostics.length > 0 || future.columns.some((column) => column.tsType === "unknown"));
      for (const source of [
        "CREATE TABLE x(id integer)",
        "DROP TABLE users",
        "SELECT id FROM users; DELETE FROM users",
      ]) {
        strict.ok(dialect.analyze(source, snapshot).diagnostics.length > 0, `${dialect.id}: ${source}`);
      }
    }
  });
  await it("compiles each grammar's repeated named binds with ordered physical metadata and UTF16 ranges", () => {
    for (const { dialect, snapshot } of grammars) {
      const source = "SELECT id, '😀 :not_a_bind' AS label FROM users WHERE id=:id OR id=:id -- :ignored\n";
      const result = compileSqlFile({ dialect, schema: snapshot, source });
      strict.deepEqual(result.diagnostics, [], dialect.id);
      strict.match(result.text, /parameters: \{ "id": bigint/u);
      strict.match(result.text, /readonly \[bigint, bigint\]/u);
      strict.equal(result.query?.variants[0]?.parameters.length, 2);
      strict.deepEqual(
        dialect.parameterOccurrences!(source, snapshot).map((parameter) =>
          source.slice(parameter.range.start, parameter.range.end),
        ),
        [":id", ":id"],
      );
      strict.ok(result.query?.variants[0]?.parameters.every((parameter) => parameter.databaseType !== undefined));
      strict.ok(!/\bany\b/u.test(result.text));
    }
  });
});
