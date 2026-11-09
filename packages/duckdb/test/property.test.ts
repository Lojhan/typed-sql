import { it, strict } from "poku";
import { defaultDuckDBCatalog, duckDBBuiltinSignatures, duckDBScalarImplicitCast } from "../src/catalog/index.js";
import { matchDuckDBBuiltin } from "../src/catalog/resolution.js";
import { decodeDuckDBValue, encodeDuckDBValue } from "../src/codecs.js";
import { formatDuckDBType, parseDuckDBType } from "../src/native-types.js";
import { defaultDuckDBTypePolicy, duckDBRuntimeType, duckDBTypeScript } from "../src/type-policy.js";

await it("keeps a bare polymorphic MAP result unresolved instead of dereferencing absent child types", () => {
  for (const version of ["1.5.6", "2.0.0"]) {
    const matches = matchDuckDBBuiltin(version, "histogram", [parseDuckDBType("NULL")], defaultDuckDBCatalog);
    strict.ok(matches.length > 0);
    strict.ok(matches.every(({ result }) => result === undefined));
  }
});

await it("round trips a deterministic native type corpus without flattening nesting or quoted names", () => {
  const leaves = [
    "BOOL",
    "INT1",
    "INT2",
    "INT4",
    "INT8",
    "INT128",
    "UINT8",
    "UINT16",
    "UINT32",
    "UINT64",
    "UINT128",
    "REAL",
    "DOUBLE PRECISION",
    "STRING",
    "NUMERIC(18,4)",
    "TIMESTAMP WITH TIME ZONE",
    "TIMESTAMP WITHOUT TIME ZONE",
    "TIME WITH TIME ZONE",
    "TIME WITHOUT TIME ZONE",
    "VARCHAR(100)",
    "LIST(INTEGER)",
    "ENUM('a,b','it''s')",
  ];
  for (const leaf of leaves)
    for (const source of [
      leaf,
      `${leaf}[]`,
      `${leaf}[3]`,
      `STRUCT("a,b" ${leaf},"quote""name" ${leaf}[])`,
      `MAP(INTEGER[],${leaf})`,
      `UNION(n ${leaf},s VARCHAR)`,
      `TUPLE(${leaf},VARCHAR)`,
    ]) {
      const parsed = parseDuckDBType(source),
        canonical = formatDuckDBType(parsed);
      strict.deepEqual(parseDuckDBType(canonical), parsed, source);
      strict.ok(duckDBRuntimeType(parsed));
      strict.ok(duckDBTypeScript(parsed));
    }
  for (const source of [
    "",
    "INTEGER!",
    "'unterminated",
    'STRUCT("unterminated INTEGER)',
    "DECIMAL(0,0)",
    "VARCHAR(1,2)",
    "MAP(INTEGER)",
    "TUPLE()",
    "ENUM(a)",
    "ENUM('a','a')",
    "unsupported(1)",
    "INTEGER[9007199254740993]",
    "STRUCT(x INTEGER",
    `INT${"[]".repeat(1025)}`,
    "X".repeat(65537),
  ])
    strict.throws(() => parseDuckDBType(source), Error, source.slice(0, 100));
  strict.throws(
    () => decodeDuckDBValue([1], parseDuckDBType("INTEGER[]"), defaultDuckDBTypePolicy, "x", { remaining: 0 }),
    /limit/u,
  );
  strict.throws(
    () => encodeDuckDBValue([1], parseDuckDBType("INTEGER[]"), defaultDuckDBTypePolicy, "x", { remaining: 0 }),
    /limit/u,
  );
});
await it("matches generic native catalog families and rejects incompatible arities and targets", () => {
  for (const version of ["1.5.6", "2.0.0"]) {
    for (const [name, types] of [
      ["map_keys", ["MAP(INTEGER,VARCHAR)"]],
      ["map_values", ["MAP(INTEGER,VARCHAR)"]],
      ["map_entries", ["MAP(INTEGER,VARCHAR)"]],
      ["map_extract_value", ["MAP(INTEGER,VARCHAR)", "INTEGER"]],
      ["map_from_entries", ["STRUCT(key INTEGER,value VARCHAR)[]"]],
      ["list_distinct", ["BIGINT[]"]],
      ["array_dot_product", ["FLOAT[3]", "FLOAT[3]"]],
      ["array_cross_product", ["DOUBLE[3]", "DOUBLE[3]"]],
      ["lower", ["NULL"]],
      ["lower", ["ANY"]],
      ["gcd", ["INTEGER", "BIGINT"]],
    ] as const)
      strict.ok(
        matchDuckDBBuiltin(version, name, types.map(parseDuckDBType), defaultDuckDBCatalog).length,
        `${version}:${name}`,
      );
    for (const [name, types] of [
      ["lower", ["INTEGER"]],
      ["lower", []],
      ["lower", ["VARCHAR", "VARCHAR"]],
      ["map_keys", ["INTEGER"]],
      ["array_cross_product", ["DOUBLE[4]", "DOUBLE[4]"]],
      ["map_extract_value", ["MAP(INTEGER,VARCHAR)", "VARCHAR"]],
    ] as const)
      strict.equal(
        matchDuckDBBuiltin(version, name, types.map(parseDuckDBType), defaultDuckDBCatalog).length,
        0,
        `${version}:${name}`,
      );
    strict.equal(duckDBScalarImplicitCast(version, "INTEGER", "INTEGER"), true);
    strict.equal(duckDBScalarImplicitCast(version, "INTEGER", "VARCHAR"), false);
  }
  strict.deepEqual(duckDBBuiltinSignatures("future", "lower"), []);
  strict.equal(duckDBScalarImplicitCast("future", "INTEGER", "BIGINT"), false);
});
