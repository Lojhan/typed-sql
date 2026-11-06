import assert from "node:assert/strict";
import * as sdk from "@duckdb/node-api";
import { getQueryValuePlan } from "@typed-sql/core";
import { createNodeDuckDBDatabase } from "@typed-sql/duckdb/node-api";
import { conditional, find, inline, repeated } from "./dist/output.mjs";

assert.equal(sdk.version(), process.env.TYPED_SQL_DUCKDB_EXPECTED_ENGINE);
const db = await createNodeDuckDBDatabase({ path: "persistent.duckdb" });
try {
  for (const query of [
    find({ id: 4n }),
    inline(4n),
    repeated([4n, 9223372036854775807n]),
    conditional(true),
    conditional(false),
  ])
    assert.equal(getQueryValuePlan(query)?.dialect, "duckdb");
  for (const query of [find({ id: 4n }), inline(4n)]) {
    const row = await db.one(query);
    assert.equal(row.id, 4n);
    assert.equal(row.amount, "1234567890123456789012345678.1234567890");
    assert.deepEqual(row.profile.choice, { tag: "n", value: null });
    assert.deepEqual(row.profile.attrs, [
      [1, "one"],
      [2, null],
    ]);
    assert.deepEqual(row.coordinates, [1, null, 3]);
    assert.deepEqual(row.bytes, Uint8Array.from([0, 255, 128]));
  }
  assert.deepEqual(await db.all(repeated([4n, 9223372036854775807n])), [{ id: 4n }, { id: 9223372036854775807n }]);
  assert.deepEqual(await db.one(conditional(false)), { id: 4n });
  assert.deepEqual((await db.one(conditional(true))).profile.choice, { tag: "n", value: null });
  console.log(
    "packed esbuild SQL assets, inline queries, mapped and conditional fragments executed exact native values",
  );
} finally {
  await db.close();
}
