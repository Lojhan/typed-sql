import { it, strict } from "poku";
import { duckdb } from "../src/index.js";
import type { DuckDBSchemaSnapshot } from "../src/snapshot.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const snapshot: DuckDBSchemaSnapshot = {
  formatVersion: 1,
  dialect: "duckdb",
  server: fixtureEvidence("2.0.0", { currentCatalog: "db", currentSchema: "main" }),
  tables: {
    t: {
      name: "t",
      schema: "main",
      columns: {
        id: { name: "id", databaseType: "INTEGER", tsType: "number", nullable: false },
        label: { name: "label", databaseType: "VARCHAR", tsType: "string", nullable: true },
        arr: { name: "arr", databaseType: "INTEGER[]", tsType: "readonly (number|null)[]", nullable: true },
        tuple: {
          name: "tuple",
          databaseType: "TUPLE(INTEGER,VARCHAR)",
          tsType: "readonly [number|null,string|null]",
          nullable: true,
        },
      },
    },
    u: {
      name: "u",
      schema: "main",
      columns: {
        id: { name: "id", databaseType: "BIGINT", tsType: "bigint", nullable: false },
        obj: { name: "obj", databaseType: "STRUCT(a INTEGER)", tsType: '{readonly "a":number|null}', nullable: true },
      },
    },
  },
};
await it("fails closed across invalid, ambiguous, unsupported and hostile SQL", () => {
  const invalid = [
    "SELECT missing FROM t",
    "SELECT (SELECT 1 AS a,2 AS b) AS value",
    "SELECT (1).missing AS value",
    "SELECT row(1)[0] AS value",
    "SELECT 1[1] AS value",
    "SELECT lambda x:x AS value",
    "SELECT list_transform([1]) AS value",
    "SELECT list_transform([1],1) AS value",
    "SELECT list_transform([1],lambda x,y,z:x) AS value",
    "SELECT list_reduce([1],lambda a,b:{'x':a}) AS value",
    "SELECT list_reduce([1],lambda a,b:a,'wrong'::VARCHAR) AS value",
    "SELECT union_value(n:=1,s:='x') AS value",
    "SELECT union_extract(union_value(n:=1),'missing') AS value",
    "SELECT struct_extract({'x':1},$1) AS value",
    "SELECT map(1,2) AS value",
    "SELECT [1]||{'a':1} AS value",
    "SELECT 1->'$.a' AS value",
    "SELECT row_number() AS value",
    "SELECT sum(id) OVER unknown AS value FROM t",
    "SELECT id,row_number() OVER w AS n FROM t WINDOW w AS(missing)",
    "SELECT id FROM t GROUP BY sum(id)",
    "SELECT * FROM t GROUP BY id",
    "SELECT id AS a FROM t GROUP BY 0",
    "SELECT 1.2::DECIMAL(38,20)*1.3::DECIMAL(38,20) AS value",
    "SELECT 1::STRUCT() AS value",
    "SELECT 1::INTEGER[-1] AS value",
    "SELECT * FROM unnest(1)",
    "SELECT * FROM unnest([1],[2])",
    "SELECT * FROM t AS alias(a,b,c,d,e)",
    "SELECT * FROM (SELECT id FROM t) AS alias(a,b)",
    "SELECT id FROM t JOIN u ON t.id=u.id",
    "SELECT t.missing FROM t",
    "SELECT id FROM missing",
    "SELECT id FROM t UNION SELECT id,label FROM t",
    "SELECT 1 INTERSECT BY NAME SELECT 1",
    "SELECT id FROM t ORDER BY id UNION SELECT id FROM t",
    "WITH x AS(SELECT 1),x AS(SELECT 2) SELECT * FROM x",
    "SELECT * EXCLUDE(missing) FROM t",
    "SELECT id FROM t JOIN u USING(missing)",
    "SELECT mystery(id) FROM t",
    "SELECT unnest(1)",
    "SELECT unnest([1],recursive:=$1)",
    "SELECT unnest([1],max_depth:=0)",
    "SELECT id,count(*) FROM t",
    "SELECT id FROM t GROUP BY label",
    "SELECT sum(sum(id)) FROM t",
    "SELECT lower(label) FILTER(WHERE id>0) FROM t",
    "SELECT lower(label) OVER() FROM t",
    "SELECT id FROM t QUALIFY id>0",
    "SELECT row_number() OVER() AS rn FROM t WHERE rn>1",
    "SELECT id FROM t GROUP BY 9",
    "SELECT grouping(id) FROM t",
    "SELECT {} AS value",
    "SELECT struct_pack(id) FROM t",
    "SELECT list_filter([1],lambda x:MAP {'x':1})",
    "SELECT list_reduce([1],lambda x:x)",
    "SELECT list_transform(1,lambda x:x)",
    "SELECT list_transform([1],lambda x,x:x)",
    "SELECT list_transform([1],lambda x:missing)",
    "SELECT list_transform([1],x -> x)",
    "SELECT id FROM t CROSS JOIN u ON t.id=u.id",
    "SELECT id FROM t ASOF JOIN u ON t.id=u.id",
    "SELECT id FROM t FOR UPDATE",
    "PIVOT t ON label USING count(*)",
    "SELECT COLUMNS('dynamic.*') FROM t",
    "SELECT * FROM read_csv('unknown.csv')",
    "SELECT id FROM t; DELETE FROM t",
    "SELECT 'unterminated",
    "SELECT /* unterminated",
    "SELECT $$unterminated",
    "SELECT ?0",
    "SELECT $0",
    "SELECT $65536",
    "SELECT : missing",
    "SELECT @bad",
  ];
  for (const source of invalid) {
    const result = duckdb().analyze(source, snapshot);
    strict.ok(result.diagnostics.length, source);
    strict.equal(result.semantics?.operation.value, "unknown", source);
    for (const diagnostic of result.diagnostics) {
      strict.ok(
        diagnostic.range.start >= 0 &&
          diagnostic.range.end >= diagnostic.range.start &&
          diagnostic.range.end <= source.length,
        source,
      );
    }
    for (const column of result.columns) strict.equal(/\bany\b/u.test(column.tsType), false, source);
  }
  const legacy = { ...snapshot, server: fixtureEvidence("1.5.6", { currentCatalog: "db", currentSchema: "main" }) };
  strict.equal(duckdb().analyze("SELECT arr::TIME_NS[] FROM t", legacy).diagnostics[0]?.code, "TSQ401");
  const huge = duckdb().analyze(" ".repeat(1000001), snapshot);
  strict.equal(huge.diagnostics[0]?.code, "TSQ002");
  const nested = duckdb().analyze(`SELECT ${"(".repeat(150)}1${")".repeat(150)}`, snapshot);
  strict.equal(nested.diagnostics[0]?.code, "TSQ002");
  strict.ok(duckdb().analyze("SELECT a+1 AS a", snapshot).diagnostics.length);
  const source = "SELECT '😀' AS emoji,\n missing FROM t";
  strict.equal(
    duckdb()
      .analyze(source, snapshot)
      .diagnostics.find((item) => item.message.includes("missing"))?.range.start,
    source.indexOf("missing"),
  );
});
await it("keeps ordered parameters, tuple NULLs and conservative cardinality evidence sound", () => {
  const query = "SELECT id,label FROM t WHERE id=$2 AND label=$1 AND id=$2";
  const analysis = duckdb().analyze(query, snapshot);
  strict.deepEqual(analysis.diagnostics, []);
  strict.deepEqual(
    analysis.parameters.map((parameter) => [parameter.index, parameter.tsType]),
    [
      [1, "string"],
      [2, "number"],
    ],
  );
  strict.equal(
    duckdb()
      .analyze("SELECT id FROM t WHERE id=$1 AND label=$1", snapshot)
      .diagnostics.some((item) => item.code === "TSQ202"),
    true,
  );
  strict.equal(
    duckdb()
      .analyze("SELECT t.id FROM t JOIN u ON t.arr=$1 AND u.obj=$1", snapshot)
      .diagnostics.some((item) => item.code === "TSQ202"),
    true,
  );
  const tuple = duckdb().analyze("SELECT row(NULL,1)[1] AS value", snapshot);
  strict.deepEqual(tuple.diagnostics, []);
  strict.equal(tuple.columns[0]?.nullable, true);
  for (const query of [
    "SELECT 1 WHERE false",
    "SELECT 1 LIMIT 0",
    "SELECT 1 OFFSET 1",
    "SELECT unnest([1,2]) AS value",
    "SELECT 1 UNION SELECT 2",
  ]) {
    const result = duckdb().analyze(query, snapshot);
    strict.deepEqual(result.diagnostics, [], query);
    strict.equal(result.semantics?.cardinality.minimum, 0, query);
  }
  strict.equal(duckdb().analyze("SELECT unnest([1,2]) AS value", snapshot).semantics?.cardinality.maximum, "many");
  strict.equal(duckdb().analyze("SELECT 1 LIMIT 0", snapshot).semantics?.cardinality.maximum, 0);
  strict.equal(duckdb().analyze("SELECT nextval('sequence') AS value", snapshot).semantics?.operation.value, "write");
  strict.equal(
    duckdb().analyze("SELECT currval('sequence') AS value", snapshot).semantics?.connectionAffinity.value,
    "session",
  );
});
