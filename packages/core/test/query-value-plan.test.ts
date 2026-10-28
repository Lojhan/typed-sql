import { describe, it, strict } from "poku";
import { sql } from "../src/query.js";
import {
  assertQueryResultTransport,
  decodeQueryResultRows,
  defineQueryValuePlan,
  encodeQueryValues,
  getQueryValuePlan,
  type QueryTransportProfile,
  QueryValueError,
  type QueryValuePlan,
  withQueryValuePlan,
} from "../src/query-value-plan.js";
import type { StandardSchemaV1 } from "../src/result-validation.js";

const text: QueryTransportProfile = { id: "test", dialect: "sqlite", integer: "lossless", jsonWire: "text" };
const parsed: QueryTransportProfile = { ...text, jsonWire: "parsed" };
function plan(overrides: Partial<QueryValuePlan> = {}): QueryValuePlan {
  return {
    dialect: "sqlite",
    typePolicyHash: "policy",
    columns: [
      {
        name: "value",
        type: "unknown",
        nullable: false,
        json: { shape: { kind: "string" }, representation: "parsed" },
      },
    ],
    parameters: [],
    ...overrides,
  };
}
await describe("query value plans", async () => {
  await it("distinguishes wire JSON strings from parsed scalar strings", () => {
    const query = withQueryValuePlan(sql<{ value: unknown }>`select 1`, plan());
    strict.equal(decodeQueryResultRows(query, [{ value: '"hello"' }], text)[0]?.value, "hello");
    strict.equal(decodeQueryResultRows(query, [{ value: '"hello"' }], parsed)[0]?.value, '"hello"');
    strict.throws(() => decodeQueryResultRows(query, [{ value: "bad json" }], text), QueryValueError);
    strict.throws(() => decodeQueryResultRows(query, [{ value: "42" }], text), QueryValueError);
    strict.throws(() => decodeQueryResultRows(query, [{}], text), QueryValueError);
  });
  await it("fails before dispatch for an incompatible integer or policy profile", () => {
    const query = withQueryValuePlan(
      sql<{ value: unknown }>`select 1`,
      plan({ columns: [{ name: "value", type: "bigint", nullable: false }] }),
    );
    strict.throws(() => assertQueryResultTransport(query, { ...text, integer: "safe-number" }), /bigint/);
    strict.throws(() => assertQueryResultTransport(query, { ...text, typePolicyHash: "other" }), /policies/);
    strict.throws(() => assertQueryResultTransport(query, { ...text, dialect: "postgres" }), /policies/);
    strict.throws(() => decodeQueryResultRows(query, [{ value: Number.MAX_SAFE_INTEGER + 1 }], text), QueryValueError);
  });
  await it("snapshots descriptors without retaining mutable caller metadata", () => {
    const input = plan();
    const query = withQueryValuePlan(sql<{ value: unknown }>`select 1`, input);
    strict.notEqual(getQueryValuePlan(query), input);
    strict.ok(Object.isFrozen(getQueryValuePlan(query)?.columns[0]?.json?.shape));
    strict.throws(() => withQueryValuePlan(query, input), /already/);
    strict.throws(() => assertQueryResultTransport(sql<{ value: unknown }>`select 1`, text), /metadata/);
  });
  await it("preserves metadata through a result validator and enforces JSON null separately", () => {
    const query = withQueryValuePlan(
      sql<{ value: unknown }>`select 1`,
      plan({
        columns: [
          {
            name: "value",
            type: "unknown",
            nullable: false,
            json: { representation: "parsed", shape: { kind: "null" } },
          },
        ],
      }),
    );
    const schema: StandardSchemaV1<unknown, { value: unknown }> = {
      "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value: { value } }) },
    };
    const validated = sql.validateResult(query, schema);
    strict.equal(getQueryValuePlan(validated), getQueryValuePlan(query));
    strict.equal(decodeQueryResultRows(query, [{ value: "null" }], text)[0]?.value, null);
    strict.equal(decodeQueryResultRows(query, [{ value: null }], parsed)[0]?.value, null);
    strict.throws(() => decodeQueryResultRows(query, [{ value: null }], text), /SQL NULL/);
  });
  await it("validates inputs before serializing and never serializes ordinary text", () => {
    const query = withQueryValuePlan(
      sql`select ${"x"}`,
      plan({
        parameters: [
          {
            index: 1,
            type: "unknown",
            nullable: false,
            json: { shape: { kind: "array", element: { kind: "number" } }, representation: "parsed" },
          },
        ],
      }),
    );
    strict.deepEqual(encodeQueryValues(query, [[1, 2]], text), ["[1,2]"]);
    strict.throws(() => encodeQueryValues(query, [[1, "x"]], text), QueryValueError);
    strict.throws(() => encodeQueryValues(query, [], text), /count/);
    const ordinary = withQueryValuePlan(
      sql`select ${"x"}`,
      plan({ parameters: [{ index: 1, type: "string", nullable: false }] }),
    );
    strict.deepEqual(encodeQueryValues(ordinary, ["{}"], text), ["{}"]);
    strict.throws(() => encodeQueryValues(ordinary, [null], text), /SQL NULL/);
  });
  await it("normalizes explicit scalar codecs and preserves binary/array values", () => {
    const query = withQueryValuePlan(
      sql<{ value: unknown }>`select 1`,
      plan({ columns: [{ name: "value", type: { array: { union: ["number", "string"] } }, nullable: false }] }),
    );
    strict.deepEqual(decodeQueryResultRows(query, [{ value: [1, "two", null] }], text), [{ value: [1, "two", null] }]);
    strict.throws(() => decodeQueryResultRows(query, [{ value: [true] }], text), /union/);
    strict.throws(() => decodeQueryResultRows(query, [{ value: 1 }], text), /array/);
    const bytes = new Uint8Array([1, 2]);
    const binary = withQueryValuePlan(
      sql<{ value: unknown }>`select 1`,
      plan({
        columns: [
          {
            name: "value",
            type: "bytes",
            nullable: false,
            json: { representation: "binary", shape: { kind: "unknown" } },
          },
        ],
      }),
    );
    strict.equal(decodeQueryResultRows(binary, [{ value: bytes }], text)[0]?.value, bytes);
    strict.throws(() => decodeQueryResultRows(binary, [{ value: "blob" }], text), /bytes/);
    const numeric = withQueryValuePlan(
      sql<{ value: unknown }>`select 1`,
      plan({ columns: [{ name: "value", type: "number", nullable: false }] }),
    );
    strict.deepEqual(
      decodeQueryResultRows(numeric, [{ value: "42" }], { ...text, normalizeValue: (value) => Number(value) }),
      [{ value: 42 }],
    );
    strict.throws(
      () => decodeQueryResultRows(numeric, [{ value: "42" }], { ...text, normalizeValue: () => null }),
      /number/,
    );
  });
  await it("rejects lossy SQL-null/JSON-null text profiles and retains special column names", () => {
    const input = plan({
      columns: [
        { name: "value", type: "unknown", nullable: true, json: { representation: "text", shape: { kind: "null" } } },
      ],
    });
    const nullable = withQueryValuePlan(sql`select 1`, input);
    strict.throws(() => assertQueryResultTransport(nullable, parsed), /distinguish/);
    const nonnull = withQueryValuePlan(sql<{ value: unknown }>`select 1`, {
      ...input,
      columns: input.columns.map((column) => ({ ...column, nullable: false })),
    });
    strict.equal(decodeQueryResultRows(nonnull, [{ value: null }], parsed)[0]?.value, "null");
    const special = withQueryValuePlan(
      sql`select 1`,
      plan({ columns: [{ name: "__proto__", type: "string", nullable: false }] }),
    );
    const row = decodeQueryResultRows(special, [JSON.parse('{"__proto__":"safe"}')], text)[0];
    strict.equal(Object.getPrototypeOf(row), Object.prototype);
    strict.equal(Object.getOwnPropertyDescriptor(row, "__proto__")?.value, "safe");
  });
  await it("reuses prepared immutable metadata while isolating each query's values", () => {
    const prepared = defineQueryValuePlan(plan({ parameters: [{ index: 1, type: "string", nullable: false }] }));
    strict.equal(defineQueryValuePlan(prepared), prepared);
    const first = withQueryValuePlan(sql`select ${"first"}`, prepared);
    const second = withQueryValuePlan(sql`select ${"second"}`, prepared);
    strict.equal(getQueryValuePlan(first), getQueryValuePlan(second));
    strict.deepEqual(encodeQueryValues(first, ["first"], text), ["first"]);
    strict.deepEqual(encodeQueryValues(second, ["second"], text), ["second"]);
    strict.throws(
      () => defineQueryValuePlan({ ...prepared, columns: [prepared.columns[0]!, prepared.columns[0]!] }),
      /duplicate/,
    );
    strict.throws(
      () => defineQueryValuePlan({ ...prepared, parameters: [{ index: 2, type: "string", nullable: false }] }),
      /ordered/,
    );
  });
});
