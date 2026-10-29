import { describe, it, strict } from "poku";
import {
  JSON_SHAPE_LIMITS,
  type JsonShape,
  jsonArrayShape,
  jsonObjectShape,
  jsonShapeAtPath,
  jsonShapeFromValue,
  jsonShapeType,
  nullJsonShape,
  parseAndValidateJsonText,
  parseJsonShape,
  unionJsonShapes,
  unknownJsonShape,
  updateJsonShapePath,
  validateJsonValue,
} from "../src/json.js";

await describe("grammar-neutral JSON structure", async () => {
  await it("checks fresh JSON text against the same contracts as caller-owned values", () => {
    const shapes: readonly JsonShape[] = [
      unknownJsonShape,
      { kind: "number" },
      jsonArrayShape({ kind: "number" }),
      { kind: "tuple", elements: [{ kind: "number" }, nullJsonShape] },
      unionJsonShapes([{ kind: "number" }, nullJsonShape]),
      jsonObjectShape({ id: { shape: { kind: "number" } } }),
      jsonObjectShape({}, { kind: "string" }),
    ];
    for (const text of [
      "null",
      "42",
      "1e999",
      '"hello"',
      "true",
      "[]",
      "[1,2]",
      "[1,null]",
      '[1,"bad"]',
      '{"id":1}',
      '{"id":"bad"}',
      '{"id":1,"extra":true}',
      '{"id":0,"id":1}',
      '{"__proto__":{"id":1},"constructor":"safe"}',
    ]) {
      for (const shape of shapes) {
        const expected: unknown = JSON.parse(text);
        const actual = parseAndValidateJsonText(text, shape, false);
        strict.deepEqual(actual.value, expected);
        strict.equal(actual.valid, validateJsonValue(expected, shape), `${text}: ${shape.kind}`);
      }
    }
    strict.equal(parseAndValidateJsonText("1e999", { kind: "number" }, true).valid, true);
    strict.throws(() => parseAndValidateJsonText("[", unknownJsonShape, false), SyntaxError);
  });

  await it("retains depth and value-count bounds for freshly parsed JSON", () => {
    const nested = (depth: number) => `${"[".repeat(depth)}0${"]".repeat(depth)}`;
    strict.equal(parseAndValidateJsonText(nested(128), unknownJsonShape, false).valid, true);
    strict.equal(parseAndValidateJsonText(nested(129), unknownJsonShape, false).valid, false);
    const wide = (count: number) => `[${"0,".repeat(count - 1)}0]`;
    strict.equal(parseAndValidateJsonText(wide(999_999), unknownJsonShape, false).valid, true);
    strict.equal(parseAndValidateJsonText(wide(1_000_000), unknownJsonShape, false).valid, false);
  });

  await it("reads sibling getters before recursively checking the captured JSON members", () => {
    const nested = { value: 1 };
    const input = {
      nested,
      get later() {
        nested.value = Number.POSITIVE_INFINITY;
        return 0;
      },
    };
    strict.equal(validateJsonValue(input), false);
  });

  await it("distinguishes a present JSON null, an optional property and a missing path", () => {
    const shape = jsonObjectShape({
      present: { shape: nullJsonShape },
      optional: { shape: { kind: "string" }, optional: true },
      nested: { shape: jsonShapeFromValue([1, "last"]) },
    });
    strict.deepStrictEqual(jsonShapeAtPath(shape, ["present"]), { shape: nullJsonShape, presence: "always" });
    strict.strictEqual(jsonShapeAtPath(shape, ["optional"]).presence, "maybe");
    strict.strictEqual(jsonShapeAtPath(shape, ["missing"]).presence, "never");
    strict.strictEqual(jsonShapeType(jsonShapeAtPath(shape, ["nested", -1]).shape), '"last"');
    strict.strictEqual(jsonShapeAtPath(shape, ["nested", 5]).presence, "never");
    strict.strictEqual(jsonShapeAtPath(jsonArrayShape({ kind: "number" }), [100]).presence, "maybe");
    const union = unionJsonShapes([shape, jsonObjectShape({ other: { shape: { kind: "number" } } })]);
    strict.strictEqual(jsonShapeAtPath(union, ["present"]).presence, "maybe");
    strict.strictEqual(jsonShapeType(jsonShapeAtPath(union, ["present"]).shape), "null");
  });

  await it("preserves literal document structure and independently represents unknown field values", () => {
    const shape = jsonShapeFromValue({ accounts: [{ id: 1, active: true }], opaque: null });
    strict.strictEqual(
      jsonShapeType(shape),
      '{ "accounts": readonly [{ "id": 1; "active": true; }]; "opaque": null; }',
    );
    strict.strictEqual(jsonShapeType(jsonObjectShape({ value: { shape: unknownJsonShape } })), '{ "value": unknown; }');
    strict.strictEqual(jsonShapeType(jsonShapeFromValue(new Date())), "unknown");
    strict.strictEqual(jsonShapeType(jsonShapeFromValue(Number.POSITIVE_INFINITY)), "unknown");
    strict.strictEqual(jsonShapeType(unionJsonShapes([{ kind: "string" }, { kind: "string" }])), "string");
    strict.strictEqual(jsonShapeType(unionJsonShapes([shape, unknownJsonShape])), "unknown");
  });

  await it("updates and removes known paths without mutating the source or treating prototype names specially", () => {
    const original = jsonShapeFromValue(JSON.parse('{"__proto__":1,"items":[1,2],"nested":{"x":true}}'));
    const updated = updateJsonShapePath(original, ["__proto__"], { kind: "string" });
    strict.strictEqual(jsonShapeType(jsonShapeAtPath(updated, ["__proto__"]).shape), "string");
    strict.strictEqual(jsonShapeType(jsonShapeAtPath(original, ["__proto__"]).shape), "1");
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(original, ["items", 0], undefined)),
      '{ "__proto__": 1; "items": readonly [2]; "nested": { "x": true; }; }',
    );
    strict.strictEqual(
      jsonShapeAtPath(updateJsonShapePath(original, ["nested", "x"], undefined), ["nested", "x"]).presence,
      "never",
    );
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(original, ["absent"], { kind: "number" }, "replace")),
      jsonShapeType(original),
    );
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(original, ["__proto__"], { kind: "string" }, "insert")),
      jsonShapeType(original),
    );
  });

  await it("validates JSON payloads even when the structure is unknown", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [undefined, () => true, 1n, new Date(), NaN, Infinity, cyclic, Array(1), { value: undefined }])
      strict.strictEqual(validateJsonValue(value), false);
    const shape = jsonObjectShape({
      id: { shape: { kind: "number" } },
      label: { shape: { kind: "string" }, optional: true },
    });
    strict.strictEqual(validateJsonValue({ id: 1 }, shape), true);
    strict.strictEqual(validateJsonValue({ id: "1" }, shape), false);
    strict.strictEqual(validateJsonValue({ id: 1, extra: true }, shape), false);
    strict.strictEqual(
      validateJsonValue(
        { id: 1, extra: true },
        jsonObjectShape({ id: { shape: { kind: "number" } } }, unknownJsonShape),
      ),
      true,
    );
    strict.strictEqual(validateJsonValue([null, { valid: true }]), true);
    strict.strictEqual(validateJsonValue([1, 2], unknownJsonShape, { maximumValues: 1 }), false);
  });

  await it("checks closed, open, tuple, array and union payload contracts", () => {
    const cases: readonly (readonly [JsonShape, unknown, boolean])[] = [
      [{ kind: "null" }, null, true],
      [{ kind: "null" }, "null", false],
      [{ kind: "boolean" }, true, true],
      [{ kind: "boolean" }, 1, false],
      [{ kind: "literal", value: "ok" }, "ok", true],
      [{ kind: "literal", value: "ok" }, "no", false],
      [jsonArrayShape({ kind: "number" }), [1, 2], true],
      [jsonArrayShape({ kind: "number" }), [1, "x"], false],
      [jsonShapeFromValue([1, null]), [1, null], true],
      [jsonShapeFromValue([1, null]), [1], false],
      [unionJsonShapes([{ kind: "string" }, nullJsonShape]), null, true],
      [unionJsonShapes([{ kind: "string" }, nullJsonShape]), true, false],
      [jsonObjectShape({ id: { shape: { kind: "number" } } }), {}, false],
      [jsonObjectShape({}), null, false],
      [jsonObjectShape({}), [], false],
      [jsonObjectShape({}, { kind: "string" }), { extra: "value" }, true],
      [jsonObjectShape({}, { kind: "string" }), { extra: 1 }, false],
    ];
    for (const [shape, value, expected] of cases) strict.strictEqual(validateJsonValue(value, shape), expected);
    strict.strictEqual(validateJsonValue(1, unknownJsonShape, { maximumDepth: 0 }), false);
    strict.strictEqual(validateJsonValue(1, unknownJsonShape, { maximumValues: NaN }), false);
    strict.strictEqual(validateJsonValue({ nested: { x: 1 } }, unknownJsonShape, { maximumDepth: 1 }), false);
    const open = jsonObjectShape({ known: { shape: { kind: "number" }, optional: true } }, { kind: "string" });
    strict.strictEqual(jsonShapeAtPath(open, ["unknown"]).presence, "maybe");
    strict.ok(jsonShapeType(open).includes("undefined"));
    strict.deepStrictEqual(parseJsonShape(JSON.parse(JSON.stringify(open))), open);
    strict.deepStrictEqual(parseJsonShape(jsonArrayShape({ kind: "number" })), jsonArrayShape({ kind: "number" }));
    strict.strictEqual(
      parseJsonShape({ kind: "union", variants: [{ kind: "number" }, { kind: "string" }] }).kind,
      "union",
    );
    strict.throws(() => parseJsonShape({ kind: "nonsense" }));
  });

  await it("keeps structural update modes and uncertain array positions conservative", () => {
    const tuple = jsonShapeFromValue([1, { nested: true }]);
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(tuple, [2], { kind: "string" })),
      'readonly [1, { "nested": true; }, string]',
    );
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(tuple, [2], { kind: "string" }, "replace")),
      jsonShapeType(tuple),
    );
    strict.strictEqual(jsonShapeType(updateJsonShapePath(tuple, [-10], undefined)), jsonShapeType(tuple));
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(tuple, [0], { kind: "string" }, "insert")),
      jsonShapeType(tuple),
    );
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(tuple, [1, "nested"], { kind: "number" })),
      'readonly [1, { "nested": number; }]',
    );
    const array = jsonArrayShape({ kind: "number" });
    strict.strictEqual(
      jsonShapeType(updateJsonShapePath(array, [10], { kind: "string" })),
      "readonly (number | string)[]",
    );
    strict.strictEqual(updateJsonShapePath(array, [1], undefined), array);
    strict.strictEqual(updateJsonShapePath({ kind: "string" }, ["x"], { kind: "number" }).kind, "string");
    strict.strictEqual(updateJsonShapePath(unknownJsonShape, ["x"], { kind: "number" }), unknownJsonShape);
    strict.strictEqual(updateJsonShapePath(tuple, [], nullJsonShape), nullJsonShape);
    const union = unionJsonShapes([jsonShapeFromValue({ x: 1 }), jsonShapeFromValue({ x: 2 })]);
    strict.strictEqual(jsonShapeType(updateJsonShapePath(union, ["x"], { kind: "boolean" })), '{ "x": boolean; }');
    const openNested = jsonObjectShape({}, jsonObjectShape({ x: { shape: { kind: "number" } } }));
    const changedNested = updateJsonShapePath(openNested, ["a", "x"], { kind: "string" });
    strict.strictEqual(validateJsonValue({ a: { x: "changed" } }, changedNested), true);
    strict.strictEqual(validateJsonValue({}, changedNested), true);
    const open = jsonObjectShape({}, { kind: "string" });
    const inserted = updateJsonShapePath(open, ["x"], { kind: "number" }, "insert");
    strict.strictEqual(jsonShapeType(jsonShapeAtPath(inserted, ["x"]).shape), "string | number");
    strict.strictEqual(jsonShapeAtPath(inserted, ["x"]).presence, "always");
    strict.strictEqual(
      jsonShapeAtPath(updateJsonShapePath(open, ["x"], { kind: "number" }, "replace"), ["x"]).presence,
      "maybe",
    );
    const optional = jsonObjectShape({ x: { shape: { kind: "number" }, optional: true } });
    strict.strictEqual(
      jsonShapeAtPath(updateJsonShapePath(optional, ["x"], { kind: "string" }), ["x"]).presence,
      "always",
    );
  });

  await it("validates persisted shape metadata and bounds cyclic or exponentially expanded descriptions", () => {
    const shape = jsonShapeFromValue({ x: [1, null, "last"] });
    strict.deepStrictEqual(parseJsonShape(JSON.parse(JSON.stringify(shape))), shape);
    for (const invalid of [
      null,
      [],
      { kind: "number", extra: 1 },
      { kind: "literal", value: NaN },
      { kind: "union", variants: [] },
      { kind: "object", properties: { x: { shape: { kind: "number" }, optional: "yes" } } },
    ]) {
      strict.throws(() => parseJsonShape(invalid));
    }
    let expanded: JsonShape = { kind: "number" };
    for (let index = 0; index < 30; index++)
      expanded = jsonObjectShape({ left: { shape: expanded }, right: { shape: expanded } });
    strict.ok(jsonShapeType(expanded).includes("unknown"));
    strict.ok(JSON.stringify(expanded).length < 100_000);
    const cyclic: {
      kind: "object";
      properties: Record<string, { shape: JsonShape }>;
      additionalProperties?: JsonShape;
    } = { kind: "object", properties: {} };
    cyclic.additionalProperties = cyclic;
    strict.strictEqual(jsonShapeType(cyclic), "unknown");
    strict.throws(() => parseJsonShape(cyclic), /limit/u);
    strict.ok(jsonShapeType(shape).length <= JSON_SHAPE_LIMITS.maximumTypeLength);
  });
});
