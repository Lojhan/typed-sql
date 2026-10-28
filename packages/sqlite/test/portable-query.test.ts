import { it, strict } from "poku";
import { assertRuntimeAdapterConformance } from "../../conformance/src/index.js";
import { sql, sqliteRenderer, sqliteRuntimeValueType } from "../src/query.js";
import { defaultSqliteTypePolicy, sqliteFlexibleType } from "../src/type-policy.js";

await it("keeps portable SQLite rendering and flexible storage unions explicit", async () => {
  await assertRuntimeAdapterConformance({
    name: "sqlite/query",
    renderer: sqliteRenderer,
    query: sql`SELECT ${7} AS n`,
    expectedText: "SELECT ? AS n",
    expectedValues: [7],
    rows: [{ n: 7 }],
  });
  for (const [tsType, expected] of [
    ["number", "number"],
    ["bigint", "bigint"],
    ["boolean", "boolean"],
    ["string", "string"],
    ["Date", "date"],
    ["Uint8Array", "bytes"],
    ["Custom", "unknown"],
  ] as const)
    strict.deepEqual(sqliteRuntimeValueType({ tsType, nullable: false }), expected);
  strict.deepEqual(sqliteRuntimeValueType({ tsType: sqliteFlexibleType(defaultSqliteTypePolicy), nullable: false }), {
    union: ["bigint", "number", "string", "bytes"],
  });
  const policy = { ...defaultSqliteTypePolicy, integer: "number" } as const;
  strict.deepEqual(sqliteRuntimeValueType({ tsType: sqliteFlexibleType(policy), nullable: false }, policy), {
    union: ["number", "string", "bytes"],
  });
});
