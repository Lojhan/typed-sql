// Run from the repository root: node --expose-gc --import tsx benchmarks/runtime-comparison/evidence/2026-10-28-runtime/selector-retention.mjs
// This measures retained selector metadata, not query execution or allocated bytes.
import {
  defineQueryValuePlanSelector,
  jsonObjectShape,
  renderQuery,
  sql,
} from "../../../../packages/core/src/index.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc");
const renderer = { placeholder: (index) => `$${index}`, quoteIdentifier: (name) => `"${name}"` };
const shape = jsonObjectShape(
  Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, { shape: { kind: "string" } }])),
);
const payload = sql.json(Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, "x"])));
const make = (count) =>
  sql`INSERT INTO docs(body) VALUES ${Array.from({ length: count }, () => sql.fragment`(${payload}::jsonb)`)}`;
const parameter = (index) => ({ index, type: "unknown", nullable: false, json: { shape, representation: "parsed" } });
const select = defineQueryValuePlanSelector(renderer, [
  {
    sql: renderQuery(make(2), renderer).text,
    plan: {
      dialect: "postgres",
      typePolicyHash: "retention-fixture",
      columns: [],
      parameters: [parameter(1), parameter(2)],
    },
    repeated: [
      {
        listIndex: 0,
        elementSql: "($1::jsonb)",
        separatorSql: ", ",
        parameterOffset: 0,
        parameterCount: 1,
        representativeItems: 2,
      },
    ],
  },
]);
globalThis.gc();
const before = process.memoryUsage().heapUsed;
for (let count = 50; count < 114; count++) select(make(count));
globalThis.gc();
console.log(
  JSON.stringify({
    node: process.version,
    fields: 500,
    cardinalities: 64,
    retainedBytes: process.memoryUsage().heapUsed - before,
  }),
);
