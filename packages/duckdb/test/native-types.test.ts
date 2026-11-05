import { describe, it, strict } from "poku";
import { decodeDuckDBValue, formatDuckDBTimestamp, parseDuckDBDecimal, parseDuckDBTemporal } from "../src/codecs.js";
import { formatDuckDBType, parseDuckDBType } from "../src/native-types.js";
import { duckDBRuntimeType, duckDBTypeScript } from "../src/type-policy.js";

await describe("DuckDB native structural types and exact policy", async () => {
  await it("round trips quoted nested fields, arbitrary map keys, unions and fixed arrays", () => {
    const type = parseDuckDBType(
      'STRUCT("a,b" MAP(INTEGER[], UNION(n BIGINT, s VARCHAR)), "arr" DECIMAL(38,4)[3], "tuple" TUPLE(INTEGER, VARCHAR))',
    );
    strict.deepEqual(parseDuckDBType(formatDuckDBType(type)), type);
    const logical = duckDBTypeScript(type);
    strict.match(logical, /bigint/u);
    strict.match(logical, /readonly \[/u);
    strict.ok(duckDBRuntimeType(type));
    for (const invalid of [
      "INTEGER[0]",
      "INTEGER[-1]",
      "INTEGER[100001]",
      "DECIMAL(39,0)",
      "DECIMAL(4,5)",
      "STRUCT(x INTEGER,X VARCHAR)",
      "UNION()",
      "INTEGER); DROP TABLE t;--",
    ])
      strict.throws(() => parseDuckDBType(invalid));
  });
  await it("preserves nested nulls, tagged null members, blobs and decimal coefficients", () => {
    const type = parseDuckDBType(
      "STRUCT(a BIGINT[], m MAP(INTEGER, BLOB), u UNION(n INTEGER,s VARCHAR), t TUPLE(INTEGER,VARCHAR), d DECIMAL(38,4))",
    );
    const bytes = Uint8Array.of(0, 255),
      native = {
        entries: {
          a: { items: [1n, null] },
          m: { entries: [{ key: 1, value: { bytes } }] },
          u: { tag: "n", value: null },
          t: { items: [1, null] },
          d: { value: 123456789012345678901200n, width: 38, scale: 4 },
        },
      };
    strict.deepEqual(decodeDuckDBValue(native, type), {
      a: [1n, null],
      m: [[1, Uint8Array.of(0, 255)]],
      u: { tag: "n", value: null },
      t: [1, null],
      d: "12345678901234567890.1200",
    });
    const result = decodeDuckDBValue({ bytes }, parseDuckDBType("BLOB")) as Uint8Array;
    bytes[0] = 99;
    strict.equal(result[0], 0);
    strict.equal(parseDuckDBDecimal("-0.1200", 38, 4), -1200n);
    strict.throws(() => parseDuckDBDecimal("1.234", 4, 2), /rounding/u);
    strict.throws(() => decodeDuckDBValue({ items: [1] }, parseDuckDBType("INTEGER[2]")), /length/u);
  });
  await it("formats and parses temporal ticks without Date or mutable SDK timezones", () => {
    for (const ticks of [0n, -1n, 1767225600123456789n]) {
      const text = formatDuckDBTimestamp(ticks, 9, true);
      strict.equal(parseDuckDBTemporal(text, "TIMESTAMPTZ_NS").ticks, ticks);
    }
    strict.equal(formatDuckDBTimestamp(-1n, 6, false), "1969-12-31 23:59:59.999999");
    strict.equal(parseDuckDBTemporal("0001-01-01 00:00:00.000000", "TIMESTAMP").ticks, -62135596800000000n);
    strict.throws(() => parseDuckDBTemporal("2025-02-29", "DATE"), /calendar/u);
    strict.throws(() => parseDuckDBTemporal("2026-01-01 00:00:00.000000001", "TIMESTAMP"), /precision/u);
  });
});
