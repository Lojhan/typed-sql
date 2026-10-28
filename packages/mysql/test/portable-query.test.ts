import { it, strict } from "poku";
import { assertRuntimeAdapterConformance } from "../../conformance/src/index.js";
import { mysqlRenderer, mysqlRuntimeValueType, sql } from "../src/query.js";

await it("keeps portable MySQL rendering and logical policy descriptors grammar-owned", async () => {
  await assertRuntimeAdapterConformance({
    name: "mysql/query",
    renderer: mysqlRenderer,
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
    strict.deepEqual(mysqlRuntimeValueType({ tsType, nullable: false }), expected);
  strict.equal(
    mysqlRuntimeValueType({ databaseType: "ENUM('a','b')", tsType: '"a" | "b"', nullable: false }),
    "string",
  );
});
