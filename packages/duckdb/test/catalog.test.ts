import { it, strict } from "poku";
import { duckDBBuiltinCatalog, duckDBServerEvidence, duckdb } from "../src/index.js";
import { formatDuckDBType } from "../src/native-types.js";
import { duckDBTypeFromSDK } from "../src/node-api.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`qualifies builtin shapes and invalid overloads against actual DuckDB${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  strict.ok(duckDBBuiltinCatalog(version).length > 2600);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const snapshot: import("../src/snapshot.js").DuckDBSchemaSnapshot = {
    formatVersion: 1 as const,
    dialect: "duckdb",
    server: duckDBServerEvidence(version),
    tables: {},
  };
  const expressions = [
    "list_transform([1,2],lambda x: x+1)",
    "list_transform([1,2],lambda x,i: x+i)",
    "list_filter([1,2],lambda x: x>1)",
    "list_transform([[1,2],[3]],lambda xs: list_transform(xs,lambda x:x+1))",
    "list_reduce([1,2],lambda a,b:a+b)",
    "list_reduce([1,2],lambda a,b:a+b,0::BIGINT)",
    "[x*2 FOR x IN [1,2,3] IF x>1]",
    "MAP {'a':1,'b':2}",
    "('{\"a\":1}'::JSON -> '$.a')",
    "('{\"a\":1}'::JSON ->> '$.a')",
    "1::TINYINT+2::SMALLINT",
    "1::FLOAT/2::FLOAT",
    "DATE '2026-01-01'+1",
    "[1]||[2]",
    "'a'::BLOB||'b'::BLOB",
    "1.23::DECIMAL(12,2)+1::SMALLINT",
    "1.23::DECIMAL(12,2)*2::DECIMAL(12,2)",

    "sum(1::BOOLEAN)",
    "sum(1::TINYINT)",
    "sum(1::UHUGEINT)",
    "sum(1::BIGNUM)",
    "sum(1::FLOAT)",
    "sum(1::DECIMAL(12,2))",
    "count_if(true)",
    "count(*)",
    "cardinality(map([1],['a']))",
    "avg(INTERVAL '1 day')",
    "median(DATE '2026-01-01')",
    "median(1::INTEGER)",
    "median(1::DECIMAL(12,2))",
    "quantile_cont(1::INTEGER,0.5)",
    "quantile_cont(1::INTEGER,[0.25,0.75])",
    "quantile_cont(DATE '2026-01-01',0.5)",
    "min(1,2)",
    "max(1,2)",
    "ceil(1::INTEGER)",
    "ceil(1.23::DECIMAL(12,2))",
    "round(1.23::DECIMAL(12,2),1)",
    "trunc(1.23::DECIMAL(12,2),1)",
    "list_sort([1,2])",
    "list_reverse_sort([1,2])",
    "list_distinct([1,2])",
    "list_concat([1],[2])",
    "map_from_entries([{'key':1,'value':'x'}])",
    "map_concat(map([1],['a']),map([2],['b']))",
    "json_extract('{\"a\":1}',['$.a'])",
    "json_extract_string('{\"a\":1}',['$.a'])",
    "date_diff('day',DATE '2026-01-01',DATE '2026-01-02')",
    "date_trunc('month',DATE '2026-01-01')",
    "regexp_extract('abc','(a)',1)",
    "regexp_split_to_array('a,b',',')",
    "sha256('x')",
    "md5_number('x')",
    "gcd(12,8)",
    "factorial(5)",
  ];
  const failures: string[] = [];
  try {
    for (const expression of expressions) {
      const query = `SELECT ${expression} AS value`;
      const result = await connection.run(query);
      try {
        const native = formatDuckDBType(duckDBTypeFromSDK(result.columnType(0), sdk)),
          analysis = duckdb().analyze(query, snapshot);
        if (analysis.diagnostics.length)
          failures.push(`${expression}: ${analysis.diagnostics.map((d) => d.message).join("; ")}`);
        else if (analysis.columns[0]?.databaseType !== native)
          failures.push(`${expression}: inferred ${analysis.columns[0]?.databaseType}, native ${native}`);
        const rows = await result.getRows();
        if (rows[0]?.[0] === null && analysis.columns[0]?.nullable === false)
          failures.push(`${expression}: native SQL NULL declared nonnullable`);
      } finally {
        result.closeSync();
      }
    }
    for (const expression of [
      "lower(1)",
      "sum('x')",
      "length(12)",
      "map(1,2)",
      "list_sort(1)",
      "abs('x')",
      "sqrt(map([1],[2]))",
    ]) {
      const query = `SELECT ${expression} AS value`;
      await strict.rejects(connection.run(query));
      if (!duckdb().analyze(query, snapshot).diagnostics.length)
        failures.push(`${expression}: invalid native overload accepted`);
    }
    strict.deepEqual(failures, []);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
