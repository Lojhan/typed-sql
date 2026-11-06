import { it, strict } from "poku";
import {
  decodeDuckDBValue,
  duckDBMapKeyIdentity,
  encodeDuckDBValue,
  formatDuckDBTimestamp,
  parseDuckDBTemporal,
} from "../src/codecs.js";
import { formatDuckDBType, parseDuckDBType } from "../src/native-types.js";
import { duckdbRenderer } from "../src/query.js";
import { parseDuckDBSchemaSnapshot } from "../src/snapshot.js";
import { duckDBServerEvidence, duckDBVersionSupport, resolveDuckDBCapabilities } from "../src/support.js";
import {
  duckDBRuntimeType,
  duckDBTypeScript,
  isKnownDuckDBType,
  mapDuckDBType,
  defaultDuckDBTypePolicy as policy,
  validateDuckDBTypePolicy,
} from "../src/type-policy.js";
import { fixtureEvidence } from "./helpers/evidence.js";

await it("keeps scalar and nested codecs aligned under all supported policies", () => {
  const samples: readonly (readonly [string, unknown, unknown])[] = [
    ["BOOLEAN", true, true],
    ["INTEGER", 123, 123],
    ["UTINYINT", 255, 255],
    ["BIGINT", 123n, 123n],
    ["UBIGINT", 18446744073709551615n, 18446744073709551615n],
    ["HUGEINT", -(1n << 127n), -(1n << 127n)],
    ["UHUGEINT", (1n << 128n) - 1n, (1n << 128n) - 1n],
    ["BIGNUM", 1n << 300n, 1n << 300n],
    ["FLOAT", 1.5, 1.5],
    ["DOUBLE", -1.5, -1.5],
    ["VARCHAR", "text", "text"],
    ["JSON", '{"x":1}', '{"x":1}'],
    ["ENUM('a','b')", "a", "a"],
    ["DECIMAL(4,2)", "-0.12", { width: 4, scale: 2, value: -12n }],
    [
      "BIT",
      "0101",
      {
        toString() {
          return "0101";
        },
      },
    ],
    [
      "UUID",
      "00112233-4455-6677-8899-aabbccddeeff",
      {
        toString() {
          return "00112233-4455-6677-8899-aabbccddeeff";
        },
      },
    ],
    ["INTERVAL", { months: 1, days: -2, micros: 123n }, { months: 1, days: -2, micros: 123n }],
  ];
  for (const [native, input, storage] of samples) {
    const type = parseDuckDBType(native);
    strict.ok(isKnownDuckDBType(type));
    strict.deepEqual(decodeDuckDBValue(storage, type), input, native);
    strict.ok(duckDBRuntimeType(type));
    strict.ok(duckDBTypeScript(type));
    encodeDuckDBValue(input, type);
  }
  for (const mode of ["bigint", "string", "number"] as const) {
    const target = { ...policy, bigint: mode };
    const value = mode === "bigint" ? 42n : mode === "string" ? "42" : 42;
    strict.deepEqual(decodeDuckDBValue(42n, parseDuckDBType("BIGINT"), target), value);
    strict.equal(encodeDuckDBValue(value, parseDuckDBType("BIGINT"), target), 42n);
  }
  for (const mode of ["unknown", "JsonValue"] as const)
    strict.deepEqual(decodeDuckDBValue('{"x":1}', parseDuckDBType("JSON"), { ...policy, json: mode }), { x: 1 });
  strict.equal(duckDBTypeScript(parseDuckDBType("ENUM('a','b')"), { ...policy, enums: "string" }), "string");
  strict.equal(mapDuckDBType("BIGINT", policy), "bigint");
  strict.equal(duckDBTypeScript(parseDuckDBType("VARIANT"), { ...policy, unknown: "never" }), "never");
  strict.equal(duckDBTypeScript(parseDuckDBType("INTEGER[65]")).startsWith("readonly ("), true);
});
await it("rejects out-of-range, structurally invalid and hostile values before native handles", () => {
  const invalid: readonly (readonly [string, unknown])[] = [
    ["BOOLEAN", 1],
    ["TINYINT", 128],
    ["UTINYINT", -1],
    ["INTEGER", 1.5],
    ["BIGINT", 1],
    ["HUGEINT", 1n << 127n],
    ["UHUGEINT", -1n],
    ["FLOAT", Number.NaN],
    ["DOUBLE", Number.POSITIVE_INFINITY],
    ["VARCHAR", false],
    ["BLOB", []],
    ["BIT", "0102"],
    ["UUID", "bad"],
    ["ENUM('a')", "b"],
    ["INTEGER[2]", [1]],
    ["TUPLE(INTEGER,VARCHAR)", [1]],
    ["STRUCT(a INTEGER)", { b: 1 }],
    ["MAP(INTEGER,VARCHAR)", [[null, "x"]]],
    [
      "MAP(INTEGER,VARCHAR)",
      [
        [1, "x"],
        [1, "y"],
      ],
    ],
    [
      "MAP(INTEGER[],VARCHAR)",
      [
        [[1, null], "x"],
        [[1, null], "y"],
      ],
    ],
    ["UNION(n INTEGER,s VARCHAR)", { tag: "missing", value: 1 }],
    ["UNION(n INTEGER,s VARCHAR)", { tag: 1, value: 1 }],
    ["DECIMAL(4,2)", "999.99"],
    ["DECIMAL(4,2)", "0.001"],
    ["INTERVAL", { months: 1, days: 1, micros: 1 }],
    ["VARIANT", {}],
  ];
  for (const [native, input] of invalid)
    strict.throws(() => encodeDuckDBValue(input, parseDuckDBType(native)), Error, native);
  for (const [native, input] of [
    ["INTEGER", 1n],
    ["BLOB", {}],
    ["INTEGER[]", {}],
    ["TUPLE(INTEGER)", { items: [] }],
    ["STRUCT(a INTEGER)", { entries: {} }],
    ["MAP(INTEGER,VARCHAR)", { entries: [{ key: null, value: "x" }] }],
    ["UNION(n INTEGER)", { tag: "x", value: 1 }],
    ["DECIMAL(4,2)", { width: 5, scale: 2, value: 1n }],
    ["TIME", { micros: -1n }],
    ["TIMETZ", { micros: 1n, offset: 99999 }],
    ["UUID", {}],
    ["ENUM('a')", "b"],
    ["VARIANT", {}],
  ] as const)
    strict.throws(() => decodeDuckDBValue(input, parseDuckDBType(native)), Error, native);
  const getter = Object.defineProperty({}, "a", {
    enumerable: true,
    get() {
      throw new Error("getter executed");
    },
  });
  strict.throws(() => encodeDuckDBValue(getter, parseDuckDBType("STRUCT(a INTEGER)")), /missing native a/u);
  strict.throws(
    () => decodeDuckDBValue({ entries: getter }, parseDuckDBType("STRUCT(a INTEGER)")),
    /missing native a/u,
  );
  strict.throws(
    () => decodeDuckDBValue(9007199254740993n, parseDuckDBType("BIGINT"), { ...policy, bigint: "number" }),
    /precision/u,
  );
  strict.throws(
    () => encodeDuckDBValue("x", parseDuckDBType("BIGINT"), { ...policy, bigint: "string" }),
    /integer text/u,
  );
  strict.equal(duckDBMapKeyIdentity(-0), duckDBMapKeyIdentity(0));
});
await it("round trips native temporal precision, offsets, BC dates and infinities", () => {
  for (const name of [
    "DATE",
    "TIME",
    "TIME_NS",
    "TIMETZ",
    "TIMESTAMP",
    "TIMESTAMP_S",
    "TIMESTAMP_MS",
    "TIMESTAMP_NS",
    "TIMESTAMPTZ",
    "TIMESTAMPTZ_NS",
  ]) {
    const aware = name === "TIMETZ" || name === "TIMESTAMPTZ" || name === "TIMESTAMPTZ_NS",
      timeOnly = name.startsWith("TIME") && !name.startsWith("TIMESTAMP");
    const text = name === "DATE" ? "2026-01-01" : `${timeOnly ? "" : "2026-01-01 "}12:34:56${aware ? "+02:30" : ""}`;
    const parsed = parseDuckDBTemporal(text, name);
    strict.ok(typeof parsed.ticks === "bigint");
    encodeDuckDBValue(text, parseDuckDBType(name));
  }
  for (const name of ["DATE", "TIMESTAMP", "TIMESTAMP_NS"]) {
    strict.ok(parseDuckDBTemporal("infinity", name).ticks > 0n);
    strict.ok(parseDuckDBTemporal("-infinity", name).ticks < 0n);
  }
  strict.equal(formatDuckDBTimestamp((1n << 63n) - 1n, 6, false), "infinity");
  strict.equal(formatDuckDBTimestamp(-((1n << 63n) - 1n), 6, false), "-infinity");
  const bc = parseDuckDBTemporal("0001-01-01 00:00:00 (BC)", "TIMESTAMP");
  strict.match(formatDuckDBTimestamp(bc.ticks, 6, false), /\(BC\)$/u);
  for (const [name, text] of [
    ["DATE", "0000-01-01"],
    ["DATE", "2026-01-01 00:00:00"],
    ["TIME", "25:00:00"],
    ["TIME", "24:00:01"],
    ["TIME", "12:00:00+00"],
    ["TIMETZ", "12:00:00"],
    ["TIMETZ", "12:00:00+16:00"],
    ["TIMESTAMP", "2026-01-01"],
    ["TIMESTAMP", "invalid"],
    ["TIMESTAMP_S", "2026-01-01 00:00:00.1"],
  ])
    strict.throws(() => parseDuckDBTemporal(text!, name!), Error, `${name}:${text}`);
  strict.equal(decodeDuckDBValue({ days: 2147483647 }, parseDuckDBType("DATE")), "infinity");
  strict.equal(decodeDuckDBValue({ days: -2147483647 }, parseDuckDBType("DATE")), "-infinity");
  strict.equal(decodeDuckDBValue({ nanos: 1n }, parseDuckDBType("TIME_NS")), "00:00:00.000000001");
  strict.equal(decodeDuckDBValue({ micros: 1n, offset: -3661 }, parseDuckDBType("TIMETZ")), "00:00:00.000001-01:01:01");
});
await it("validates versions, snapshots, policies and structural rendering boundaries", () => {
  strict.equal(duckDBVersionSupport("1.4.5"), "below-supported");
  strict.equal(duckDBVersionSupport("2.1.0"), "newer-than-tested");
  strict.equal(duckDBVersionSupport("2.0.0-rc.1"), "prerelease");
  strict.equal(duckDBVersionSupport("unknown"), "unknown");
  strict.throws(() => duckDBServerEvidence("unknown"));
  for (const index of [0, -1, 65536, 1.5, Number.NaN]) strict.throws(() => duckdbRenderer.placeholder(index));
  strict.equal(duckdbRenderer.quoteIdentifier('a"b'), '"a""b"');
  for (const name of ["", "\0"]) strict.throws(() => duckdbRenderer.quoteIdentifier(name));
  for (const change of [
    { bigint: "invalid" },
    { decimal: "number" },
    { temporal: "Date" },
    { json: "any" },
    { enums: "number" },
    { unknown: "any" },
  ])
    strict.throws(() => validateDuckDBTypePolicy({ ...policy, ...change } as typeof policy));
  const snapshot: import("@typed-sql/core").SchemaSnapshot = {
    formatVersion: 1,
    dialect: "duckdb",
    dialectVersion: "1.0.0",
    server: fixtureEvidence("2.0.0"),
    tables: {},
  };
  strict.equal(parseDuckDBSchemaSnapshot(snapshot).dialect, "duckdb");
  for (const target of [
    { ...snapshot, dialect: "postgres" },
    { ...snapshot, dialectVersion: "future" },
    { ...snapshot, server: { ...snapshot.server, product: "postgres" } },
    {
      ...snapshot,
      tables: {
        t: { name: "t", columns: { x: { name: "x", databaseType: "STRUCT(", tsType: "unknown", nullable: true } } },
      },
    },
  ])
    strict.throws(() => parseDuckDBSchemaSnapshot(target));
  strict.equal(
    resolveDuckDBCapabilities({ ...snapshot, server: duckDBServerEvidence("2.1.0") }).arrays?.level,
    "conservative",
  );
  strict.equal(formatDuckDBType(parseDuckDBType("DOUBLE PRECISION")), "DOUBLE");
  strict.equal(formatDuckDBType(parseDuckDBType("TIME WITHOUT TIME ZONE")), "TIME");
});
