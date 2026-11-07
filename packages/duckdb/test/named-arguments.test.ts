import { it, strict } from "poku";
import { duckDBNamedArgumentOrder } from "../src/catalog/named-arguments.js";
import { duckdb } from "../src/index.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const legacy = process.env.TYPED_SQL_DUCKDB_SDK === "15";
const sdk = legacy ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = legacy ? "1.5.6" : "2.0.0";
await it(`binds generated formal names using native DuckDB ${version} rules`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const snapshot = {
    formatVersion: 1 as const,
    dialect: "duckdb" as const,
    server: fixtureEvidence(version),
    tables: {},
  };
  const cases = [
    { sql: "SELECT power(y := 2, x := 3) AS value", valid: true },
    { sql: "SELECT power(nope := 2, other := 3) AS value", valid: legacy },
    { sql: "SELECT power(x := 2, 3) AS value", valid: legacy },
    { sql: "SELECT power(x := 2, X := 3) AS value", valid: legacy },
    { sql: "SELECT power(X := 2, Y := 3) AS value", valid: true },
    { sql: "SELECT round(precision := 2, x := 123.456::DOUBLE) AS value", valid: !legacy },
    { sql: 'SELECT "nullif"(b := 2::SMALLINT, a := 1::INTEGER) AS value', valid: true },
    { sql: 'SELECT "nullif"(nope := 1, other := 2) AS value', valid: false },
    { sql: "SELECT nullif(b := 2, a := 1) AS value", valid: false },
    { sql: "SELECT list_count(l := [1,2]) AS value", valid: true },
    { sql: "SELECT list_count(nope := [1,2]) AS value", valid: false },
    { sql: "SELECT if(c := false, a := true, b := false) AS value", valid: true },
    { sql: "SELECT concat(value := 'a') AS value", valid: true },
    { sql: "SELECT struct_pack(a := 1, b := 'x') AS value", valid: true },
    { sql: "SELECT union_value(n := 1) AS value", valid: true },
  ];
  try {
    for (const { sql, valid } of cases) {
      let accepted = false;
      try {
        const prepared = await connection.prepare(sql);
        accepted = true;
        prepared.destroySync();
      } catch (error) {
        strict.match(String(error), /Binder Error|Parser Error|Conversion Error/u);
      }
      strict.equal(accepted, valid, sql);
      const result = duckdb().analyze(sql, snapshot);
      strict.equal(result.diagnostics.length === 0, valid, `${sql}: ${JSON.stringify(result.diagnostics)}`);
      if (!valid) {
        strict.ok(
          result.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === "TSQ201" && diagnostic.range?.start === 7 && diagnostic.range.end <= sql.length,
          ),
          sql,
        );
        strict.ok(
          result.columns.every((column) => column.tsType === "unknown"),
          sql,
        );
      }
      if (valid)
        strict.ok(
          result.columns.every((column) => column.tsType !== "unknown" && column.tsType !== "any"),
          sql,
        );
    }
    const rows = await connection.runAndReadAll("SELECT power(y := 2, x := 3)");
    strict.deepEqual(rows.getRowsJS(), [[legacy ? 8 : 9]]);
    const reversed = duckdb().analyze('SELECT "nullif"(b := 2::SMALLINT, a := 1::INTEGER) AS value', snapshot);
    strict.equal(reversed.columns[0]?.databaseType, "INTEGER");
    const parameterized = 'SELECT "nullif"(b := CAST($1 AS SMALLINT), a := CAST($2 AS INTEGER)) AS value';
    const prepared = await connection.prepare(parameterized);
    try {
      strict.equal(prepared.parameterCount, 2);
      strict.equal(prepared.columnTypeId(0), sdk.DuckDBTypeId.INTEGER);
    } finally {
      prepared.destroySync();
    }
    const parameters = duckdb().analyze(parameterized, snapshot);
    strict.deepEqual(parameters.diagnostics, []);
    strict.deepEqual(
      parameters.parameters.map((parameter) => [parameter.index, parameter.databaseType, parameter.tsType]),
      [
        [1, "SMALLINT", "number"],
        [2, "INTEGER", "number"],
      ],
    );
    strict.equal(parameters.columns[0]?.databaseType, "INTEGER");
    strict.equal(parameters.columns[0]?.nullable, true);
    strict.deepEqual(duckDBNamedArgumentOrder(version, "power", ["y", "x"], false), legacy ? [0, 1] : [1, 0]);
    strict.equal(duckDBNamedArgumentOrder("unqualified", "power", ["x", "y"], false), undefined);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
