import { describe, it, strict } from "poku";
import { sql } from "../src/query.js";
import {
  assertQueryResultTransport,
  decodeQueryResultRows,
  encodeQueryValues,
  getQueryValuePlan,
  type QueryTransportProfile,
  QueryValueError,
  type QueryValuePlan,
  withQueryValuePlan,
} from "../src/query-value-plan.js";

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
    const query = withQueryValuePlan(sql`select 1`, plan());
    strict.equal(decodeQueryResultRows(query, [{ value: '"hello"' }], text)[0]?.value, "hello");
    strict.equal(decodeQueryResultRows(query, [{ value: '"hello"' }], parsed)[0]?.value, '"hello"');
    strict.throws(() => decodeQueryResultRows(query, [{ value: "bad json" }], text), QueryValueError);
    strict.throws(() => decodeQueryResultRows(query, [{ value: "42" }], text), QueryValueError);
    strict.throws(() => decodeQueryResultRows(query, [{}], text), QueryValueError);
  });
  await it("fails before dispatch for an incompatible integer or policy profile", () => {
    const query = withQueryValuePlan(
      sql`select 1`,
      plan({ columns: [{ name: "value", type: "bigint", nullable: false }] }),
    );
    strict.throws(() => assertQueryResultTransport(query, { ...text, integer: "safe-number" }), /bigint/);
    strict.throws(() => assertQueryResultTransport(query, { ...text, typePolicyHash: "other" }), /policies/);
    strict.throws(() => assertQueryResultTransport(query, { ...text, dialect: "postgres" }), /policies/);
    strict.throws(() => decodeQueryResultRows(query, [{ value: Number.MAX_SAFE_INTEGER + 1 }], text), QueryValueError);
  });
  await it("snapshots descriptors without retaining mutable caller metadata", () => {
    const input = plan();
    const query = withQueryValuePlan(sql`select 1`, input);
    strict.notEqual(getQueryValuePlan(query), input);
    strict.ok(Object.isFrozen(getQueryValuePlan(query)?.columns[0]?.json?.shape));
    strict.throws(() => withQueryValuePlan(query, input), /already/);
    strict.throws(() => assertQueryResultTransport(sql`select 1`, text), /metadata/);
  });
  await it("preserves metadata through a result validator and enforces JSON null separately", () => {
    const query = withQueryValuePlan(
      sql`select 1`,
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
    const validated = sql.validateResult(query, {
      "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
    });
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
});
