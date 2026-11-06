import { it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { formatDuckDBType } from "../src/native-types.js";
import { duckDBTypeFromSDK } from "../src/node-api.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`qualifies expression and set-operation combination types on genuine ${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const snapshot = {
    formatVersion: 1 as const,
    dialect: "duckdb" as const,
    server: fixtureEvidence(version),
    tables: {},
  };
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect(),
    failures: string[] = [];
  const names = [
    "BOOLEAN",
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "UTINYINT",
    "USMALLINT",
    "UINTEGER",
    "UBIGINT",
    "UHUGEINT",
    "BIGNUM",
    "FLOAT",
    "DOUBLE",
    "VARCHAR",
    "JSON",
    "BLOB",
    "BIT",
    "UUID",
    "DATE",
    "TIME",
    "TIMETZ",
    "TIMESTAMP",
    "TIMESTAMP_S",
    "TIMESTAMP_MS",
    "TIMESTAMP_NS",
    "TIMESTAMPTZ",
    "INTERVAL",
    "DECIMAL(18,3)",
    ...(version === "2.0.0" ? ["TIME_NS", "TIMESTAMPTZ_NS"] : []),
  ];
  const verify = async (query: string) => {
    let native: Awaited<ReturnType<typeof connection.prepare>>;
    try {
      native = await connection.prepare(query);
    } catch {
      return;
    }
    try {
      const type = formatDuckDBType(duckDBTypeFromSDK(native.columnType(0), sdk)),
        analysis = duckdb().analyze(query, snapshot);
      if (analysis.diagnostics.length || analysis.columns[0]?.databaseType !== type)
        failures.push(
          `${query}: inferred ${analysis.columns[0]?.databaseType} expected ${type}; ${analysis.diagnostics.map((item) => item.message).join(";")}`,
        );
    } finally {
      native.destroySync();
    }
  };
  try {
    for (const a of names)
      for (const b of names) {
        await verify(`SELECT NULL::${a} AS value UNION ALL SELECT NULL::${b} AS value`);
        await verify(`SELECT list_value(NULL::${a},NULL::${b}) AS value`);
      }
    for (const query of [
      "SELECT [1::TINYINT,2::SMALLINT] AS value",
      "SELECT [1::UTINYINT,2::USMALLINT] AS value",
      "SELECT [1::UHUGEINT,2::BIGINT] AS value",
      "SELECT [1::TINYINT,1] AS value",
      "SELECT [1,1::TINYINT] AS value",
      "SELECT [1::TINYINT,200] AS value",
      "SELECT [1,200,1::TINYINT] AS value",
      "SELECT [0,4294967295,1::UINTEGER] AS value",
      "SELECT CASE WHEN true THEN 1::TINYINT ELSE 1 END AS value",
      "SELECT 1::TINYINT AS value UNION SELECT 1",
      "SELECT [array_value(1::TINYINT,2::TINYINT),array_value(1::SMALLINT,2::SMALLINT)] AS value",
      "SELECT array_value(1::TINYINT,2::TINYINT) AS value UNION ALL SELECT array_value(1::SMALLINT,2::SMALLINT)",
      "SELECT row(1) AS value UNION ALL SELECT row(2::BIGINT)",
      "SELECT map([1],[1]) AS value UNION ALL SELECT map([2::BIGINT],[2::BIGINT])",
      "SELECT {'a':1} AS value UNION ALL SELECT {'b':2}",
      "SELECT [1::DECIMAL(4,2),1::FLOAT] AS value",
      "SELECT [1::DECIMAL(4,2),1::DOUBLE] AS value",
    ])
      await verify(query);
    strict.deepEqual(failures, []);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
