import { describe, it, strict } from "poku";
import type { RuntimeValueField } from "../src/index.js";
import { jsonValue } from "../src/json-input.js";
import { renderQuery, sql } from "../src/query.js";
import {
  assertQueryResultTransport,
  decodeQueryResultRows,
  defineQueryValuePlan,
  encodeQueryValues,
  getQueryValuePlan,
  type QueryTransportProfile,
  type QueryValuePlan,
  type RuntimeValueType,
  withQueryValuePlan,
} from "../src/query-value-plan.js";
import { defineQueryValuePlanSelector } from "../src/query-value-plan-selection.js";
import { ParameterCollector } from "../src/resolver.js";
import { parameterTypeLiteral } from "../src/types.js";

const profile: QueryTransportProfile = { id: "native", dialect: "synthetic", integer: "lossless", jsonWire: "text" };
const renderer = { placeholder: (index: number) => `$${index}`, quoteIdentifier: (name: string) => name };
function plan(type: RuntimeValueType, databaseType?: string): QueryValuePlan {
  return {
    dialect: "synthetic",
    typePolicyHash: "policy",
    columns: [{ name: "value", type, nullable: true, ...(databaseType === undefined ? {} : { databaseType }) }],
    parameters: [{ index: 1, type, nullable: true, ...(databaseType === undefined ? {} : { databaseType }) }],
  };
}
function query(type: RuntimeValueType, value: unknown = null) {
  return withQueryValuePlan(sql<{ value: unknown }>`select ${value}`, plan(type));
}
const key: RuntimeValueField = { type: "bigint", nullable: false };
const entry: RuntimeValueType = {
  tuple: [key, { type: { array: "string", elementNullable: true, length: 2 }, nullable: true }],
};
const native: RuntimeValueType = {
  object: {
    id: { type: "bigint", nullable: false },
    entries: { type: { array: entry, elementNullable: false }, nullable: false },
    bytes: { type: "bytes", nullable: false },
    interval: {
      type: { object: { months: { type: "number", nullable: false }, micros: { type: "bigint", nullable: false } } },
      nullable: true,
    },
  },
};
await describe("native structural value contracts", async () => {
  await it("roundtrips owned nested values without JSON or precision loss", () => {
    const source = {
      id: 18446744073709551615n,
      entries: [
        [1n, ["first", null]],
        [2n, null],
      ],
      bytes: Uint8Array.of(0, 255),
      interval: { months: 2, micros: 9007199254740993n },
    };
    const q = query(native, source);
    const encoded = encodeQueryValues(q, [source], profile)[0];
    const decoded = decodeQueryResultRows(q, [{ value: source }], profile)[0]!.value;
    strict.deepEqual(encoded, source);
    strict.deepEqual(decoded, source);
    strict.notEqual(decoded, source);
    const owned = decoded as typeof source;
    strict.notEqual(owned.entries, source.entries);
    strict.notEqual(owned.entries[0], source.entries[0]);
    strict.notEqual(owned.bytes, source.bytes);
    strict.notEqual(owned.interval, source.interval);
    source.entries[0]![1] = ["changed", null];
    source.bytes.fill(1);
    strict.deepEqual(owned.entries[0], [1n, ["first", null]]);
    strict.deepEqual(owned.bytes, Uint8Array.of(0, 255));
    strict.deepEqual(encodeQueryValues(q, [null], profile), [null]);
    strict.deepEqual(decodeQueryResultRows(q, [{ value: null }], profile), [{ value: null }]);
  });
  await it("distinguishes missing fields, NULL members, tuple slots and fixed lengths", () => {
    const shape: RuntimeValueType = {
      object: { pair: { type: entry, nullable: false }, optional: { type: "string", nullable: true } },
    };
    const q = query(shape);
    for (const invalid of [
      { pair: [1n, ["one", null]] },
      { pair: [1n, ["one", null]], optional: null, extra: true },
      { pair: null, optional: null },
      { pair: [null, null], optional: null },
      { pair: [1n], optional: null },
      { pair: [1n, ["one"]], optional: null },
      { pair: [1n, ["one", "two", "three"]], optional: null },
    ])
      strict.throws(() => encodeQueryValues(q, [invalid], profile), /fields|NULL|length/);
    strict.throws(
      () => decodeQueryResultRows(q, [{ value: { pair: [1n, ["one", null]], optional: false } }], profile),
      /value.optional.*string/,
    );
    strict.deepEqual(encodeQueryValues(q, [{ pair: [1n, null], optional: null }], profile), [
      { pair: [1n, null], optional: null },
    ]);
    strict.deepEqual(encodeQueryValues(query({ tuple: [] }), [[]], profile), [[]]);
    strict.deepEqual(encodeQueryValues(query({ array: "number", length: 0 }), [[]], profile), [[]]);
  });
  await it("preserves tagged NULL values and rejects invalid union members", () => {
    const tagged: RuntimeValueType = {
      union: [
        { object: { tag: { type: { literal: "wide" }, nullable: false }, value: { type: "bigint", nullable: true } } },
        { object: { tag: { type: { literal: "text" }, nullable: false }, value: { type: "string", nullable: false } } },
      ],
    };
    const q = query(tagged);
    strict.deepEqual(decodeQueryResultRows(q, [{ value: { tag: "wide", value: null } }, { value: null }], profile), [
      { value: { tag: "wide", value: null } },
      { value: null },
    ]);
    for (const value of [
      { tag: "unknown", value: 1n },
      { tag: "text", value: null },
      { tag: "wide", value: "1" },
    ])
      strict.throws(() => encodeQueryValues(q, [value], profile), /union/);
    let dispatches = 0;
    strict.throws(() => {
      encodeQueryValues(q, [{ tag: "text", value: "safe" }], { ...profile, integer: "safe-number" });
      dispatches++;
    }, /bigint/);
    strict.equal(dispatches, 0);
    strict.throws(
      () =>
        assertQueryResultTransport(query({ tuple: [{ type: "bigint", nullable: true }] }), {
          ...profile,
          integer: "safe-number",
        }),
      /bigint/,
    );
  });
  await it("retains nested JSON input types and NULL ambiguity rules", () => {
    const json: RuntimeValueType = {
      json: { representation: "parsed", shape: { kind: "object", properties: { id: { shape: { kind: "number" } } } } },
    };
    const shape: RuntimeValueType = {
      object: {
        pair: {
          type: {
            tuple: [
              { type: json, nullable: false },
              { type: "string", nullable: true },
            ],
          },
          nullable: false,
        },
      },
    };
    const q = query(shape);
    strict.deepEqual(encodeQueryValues(q, [{ pair: [jsonValue({ id: 1 }), null] }], profile), [
      { pair: ['{"id":1}', null] },
    ]);
    strict.deepEqual(decodeQueryResultRows(q, [{ value: { pair: ['{"id":1}', null] } }], profile), [
      { value: { pair: [{ id: 1 }, null] } },
    ]);
    const rendered = parameterTypeLiteral(1, [{ index: 1, tsType: "unknown", nullable: false, runtimeType: shape }]);
    strict.ok(rendered.includes('readonly "pair": readonly ['));
    strict.ok(rendered.includes('import("@typed-sql/core").JsonInput<'));
    strict.ok(rendered.includes("string | null"));
    const nullableText: RuntimeValueType = { json: { representation: "text", shape: { kind: "null" } } };
    for (const type of [
      { object: { json: { type: nullableText, nullable: true } } },
      { tuple: [{ type: nullableText, nullable: true }] },
    ])
      strict.throws(() => assertQueryResultTransport(query(type), { ...profile, jsonWire: "parsed" }), /distinguish/);
    for (const type of [
      { object: { json: { type: nullableText, nullable: false } } },
      { tuple: [{ type: nullableText, nullable: false }] },
    ]) {
      const value = "object" in type ? { json: null } : [null];
      const expected = "object" in type ? { json: "null" } : ["null"];
      strict.deepEqual(decodeQueryResultRows(query(type), [{ value }], { ...profile, jsonWire: "parsed" }), [
        { value: expected },
      ]);
    }
  });
  await it("preserves prototype-like SQL names without reading inherited properties or getters", () => {
    const fields = Object.fromEntries(
      ["__proto__", "constructor"].map((name) => [name, { type: "string" as const, nullable: true }]),
    );
    const q = query({ object: fields });
    const value = JSON.parse('{"__proto__":"safe","constructor":null}');
    const result = decodeQueryResultRows(q, [{ value }], profile)[0]!.value;
    strict.equal(Object.getPrototypeOf(result), Object.prototype);
    strict.equal(Object.getOwnPropertyDescriptor(result, "__proto__")?.value, "safe");
    strict.deepEqual(result, value);
    strict.throws(() => encodeQueryValues(q, [Object.create(value)], profile), /plain object/);
    let reads = 0;
    const hostile = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      get() {
        reads++;
        return "bad";
      },
    });
    strict.throws(() => encodeQueryValues(q, [hostile], profile), /own data/);
    strict.throws(
      () =>
        decodeQueryResultRows(
          q,
          [
            Object.defineProperty({}, "value", {
              get() {
                reads++;
                return value;
              },
            }),
          ],
          profile,
        ),
      /own data/,
    );
    strict.equal(reads, 0);
  });
  await it("canonicalizes descriptors and bounds hostile metadata before dispatch", () => {
    const prepared = defineQueryValuePlan(
      plan(native, "STRUCT(id UBIGINT, entries MAP(BIGINT, VARCHAR[2]), bytes BLOB)"),
    );
    strict.equal(Object.isFrozen(prepared.columns[0]!.type), true);
    strict.deepEqual(prepared.columns[0]!.databaseType, prepared.parameters[0]!.databaseType);
    strict.equal(
      JSON.stringify(
        defineQueryValuePlan(
          plan({ object: { z: { type: "number", nullable: true }, a: { type: "string", nullable: false } } }),
        ),
      ),
      JSON.stringify(
        defineQueryValuePlan(
          plan({ object: { a: { type: "string", nullable: false }, z: { type: "number", nullable: true } } }),
        ),
      ),
    );
    let reads = 0;
    for (const bad of [
      Object.defineProperty({}, "object", {
        enumerable: true,
        get() {
          reads++;
          return {};
        },
      }),
      Object.create({ object: {} }),
      {
        object: {
          id: Object.defineProperty({}, "type", {
            enumerable: true,
            get() {
              reads++;
              return "number";
            },
          }),
        },
      },
      { tuple: new Array(1) },
      { array: "string", length: -1 },
      { array: "string", length: 1.5 },
      { tuple: [{ type: "number", nullable: "yes" }] },
      { object: {}, array: "number" },
    ])
      strict.throws(() => defineQueryValuePlan(plan(bad as RuntimeValueType)));
    strict.equal(reads, 0);
    const cycle: { object: Record<string, { type: RuntimeValueType; nullable: boolean }> } = { object: {} };
    cycle.object.self = { type: cycle, nullable: true };
    strict.throws(() => defineQueryValuePlan(plan(cycle)), /depth|expansion/);
    strict.throws(
      () =>
        defineQueryValuePlan(
          plan({ tuple: Array.from({ length: 1024 }, () => ({ type: "string", nullable: false })) }),
        ),
      /expansion/,
    );
    for (const databaseType of ["", "a".repeat(4097), "TEXT\0bad"])
      strict.throws(() => defineQueryValuePlan(plan("string", databaseType)), /database type|text limit/);
    strict.throws(
      () =>
        defineQueryValuePlan({
          ...plan("string"),
          columns: Array.from({ length: 300 }, (_, index) => ({
            name: `c${index}`,
            type: "string",
            nullable: false,
            databaseType: "x".repeat(4096),
          })),
        }),
      /text limit/,
    );
    strict.throws(() => defineQueryValuePlan(plan({ array: "string", length: Number.MAX_SAFE_INTEGER })), /length/);
    strict.throws(() => encodeQueryValues(query({ array: "number" }), [new Array(3)], profile), /own data/);
  });
  await it("retains the existing parameter ceiling with ordinary native type metadata", () => {
    const valuePlan = defineQueryValuePlan({
      dialect: "synthetic",
      typePolicyHash: "policy",
      columns: [],
      parameters: Array.from({ length: 65_535 }, (_, offset) => ({
        index: offset + 1,
        type: "number" as const,
        nullable: false,
        databaseType: "INTEGER",
      })),
    });
    strict.equal(valuePlan.parameters.length, 65_535);
    strict.equal(valuePlan.parameters[65_534]!.databaseType, "INTEGER");
    strict.equal(Object.isFrozen(valuePlan.parameters[65_534]), true);
  });
  await it("keeps physical targets through repeated-plan selection and detects conflicting native shapes", () => {
    const factory = (values: readonly string[]) => sql`insert ${values.map((value) => sql.fragment`${value}`)}`;
    const representative = factory(["one", "two"]);
    const selected = defineQueryValuePlanSelector(renderer, [
      {
        sql: renderQuery(representative, renderer).text,
        plan: {
          ...plan("string", "DECIMAL(38,8)"),
          parameters: [1, 2].map((index) => ({ index, type: "string", nullable: true, databaseType: "DECIMAL(38,8)" })),
        },
        repeated: [
          {
            listIndex: 0,
            elementSql: "$1",
            separatorSql: ", ",
            parameterOffset: 0,
            parameterCount: 1,
            representativeItems: 2,
          },
        ],
      },
    ]);
    const bound = withQueryValuePlan(factory(["one", "two", "three"]), selected);
    strict.deepEqual(
      getQueryValuePlan(bound)!.parameters.map((parameter) => parameter.databaseType),
      ["DECIMAL(38,8)", "DECIMAL(38,8)", "DECIMAL(38,8)"],
    );
    const collector = new ParameterCollector();
    collector.record(1, {
      tsType: "Shape",
      nullable: false,
      runtimeType: { object: { id: { type: "bigint", nullable: false } } },
    });
    collector.record(1, {
      tsType: "Shape",
      nullable: false,
      runtimeType: { object: { id: { type: "string", nullable: false } } },
    });
    strict.deepEqual(collector.values(), [{ index: 1, tsType: "unknown", nullable: true }]);
  });
});
