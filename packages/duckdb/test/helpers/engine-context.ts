import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { acquireNativeQueryContract } from "@typed-sql/analysis";
import { createNodeDuckDBNativeContractAdapter } from "../../src/node-api-contracts.js";
import { duckDBParameterOccurrences } from "../../src/parser/parser.js";

// Invoked in a fresh process per SDK: native libraries must never share one process.
const sdk: typeof import("@duckdb/node-api") = await import(
  process.env.TYPED_SQL_DUCKDB_SDK_PACKAGE ?? "@duckdb/node-api"
);
assert.equal(sdk.version(), process.env.TYPED_SQL_DUCKDB_EXPECTED_ENGINE);
const [destination, ...previous] = process.argv.slice(2);
assert.ok(destination);
const schema = { formatVersion: 1 as const, dialect: "duckdb" as const, tables: {} };
const adapter = createNodeDuckDBNativeContractAdapter({ path: ":memory:", schema, sdkImporter: async () => sdk });
const context = await adapter.inspectContext();
const sql = "SELECT $1::INTEGER AS value";
const candidate = {
  sql,
  parameterOccurrences: duckDBParameterOccurrences(sql).map(({ index, range }) => ({
    index,
    start: range.start,
    end: range.end,
  })),
};
const own = await acquireNativeQueryContract({ adapter, context, candidate });
assert.equal(own.status, "acquired");
for (const file of previous) {
  const before = JSON.parse(await readFile(file, "utf8"));
  assert.notEqual(before.engine, sdk.version(), "The old context must come from another actual engine");
  assert.deepEqual(before.context.grammar, context.grammar);
  assert.equal(before.context.schemaHash, context.schemaHash, "The compiler schema stays fixed across engines");
  assert.equal(before.context.typePolicyHash, context.typePolicyHash, "The decoding policy stays fixed");
  assert.notEqual(before.context.databaseContextHash, context.databaseContextHash);
  assert.deepEqual(await acquireNativeQueryContract({ adapter, context: before.context, candidate }), {
    status: "unavailable",
    reason: "context-mismatch",
  });
}
await writeFile(destination, `${JSON.stringify({ engine: sdk.version(), context })}\n`);
console.log(JSON.stringify({ engine: sdk.version(), rejectedOtherEngines: previous.length, ownContextAcquired: true }));
