import { it, strict } from "poku";
import { type DuckDBType, parseDuckDBType } from "../src/native-types.js";
import { duckDBParameterTransport } from "../src/parameter-transport.js";

await it("keeps typed NULL witnesses separate from payloads and markers deterministic", () => {
  const transport = duckDBParameterTransport(parseDuckDBType("TUPLE(UNION(n INTEGER,s VARCHAR),VARCHAR)[2]"));
  const first = transport.placeholder("$1");
  strict.equal(transport.placeholder("$1"), first);
  strict.match(first, /cast_to_type/u);
  strict.equal(first.includes(" AS TUPLE"), false);
  const value = [[{ tag: "n", value: null }, "never inline"], null];
  const wire = transport.encode(value) as Record<string, unknown>;
  for (const [name, value] of Object.entries(wire)) if (name !== "__typed_sql_payload") strict.equal(value, null);
  strict.equal(first.includes("never inline"), false);
  strict.notDeepEqual(transport.encode(null), transport.encode([[null, null], null]));
});
await it("bounds physical target expansion before constructing native handles", () => {
  let type: DuckDBType = { kind: "union", fields: [{ name: "a", type: { kind: "scalar", name: "INTEGER" } }] };
  for (let i = 0; i < 15; i++)
    type = {
      kind: "struct",
      fields: [
        { name: "a", type },
        { name: "b", type },
      ],
    };
  strict.throws(() => duckDBParameterTransport(type), /physical type expansion limit/u);
});
