import { jsonShapeType, validateJsonValue } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { calculateSchemaHash, parseSchemaSnapshot, upgradeSchemaSnapshotV1 } from "../src/index.js";
import { jsonShapeFromSchema, parseJsonDeclaration } from "../src/json-schema.js";

await describe("structural JSON Schema projection", async () => {
  await it("keeps default-open objects and optional properties conservative", () => {
    const shape = jsonShapeFromSchema({
      type: "object",
      properties: { id: { type: "integer" }, tag: { type: ["string", "null"] } },
      required: ["id"],
    });
    strict.ok(validateJsonValue({ id: 1, extra: true }, shape));
    strict.ok(!validateJsonValue({ tag: "x" }, shape));
    strict.ok(!validateJsonValue({ id: "wrong" }, shape));
    strict.match(jsonShapeType(shape), /"tag"\?/);
    strict.match(jsonShapeType(shape), /\[key: string\]: unknown/);
  });
  await it("resolves bounded local references and rejects recursive or external references", () => {
    strict.equal(
      jsonShapeType(jsonShapeFromSchema({ $defs: { id: { type: "string" } }, $ref: "#/$defs/id" })),
      "string",
    );
    strict.throws(() => jsonShapeFromSchema({ $ref: "https://example.com/schema" }), /local/);
    strict.throws(
      () => jsonShapeFromSchema({ $defs: { self: { $ref: "#/$defs/self" } }, $ref: "#/$defs/self" }),
      /Recursive/,
    );
    strict.throws(() => jsonShapeFromSchema({ allOf: [{ type: "object" }] }), /composition/);
  });
  await it("preserves closed shapes, tuples and literal alternatives", () => {
    const object = jsonShapeFromSchema({
      type: "object",
      properties: { password: { type: "string" } },
      required: ["password"],
      additionalProperties: false,
    });
    strict.ok(validateJsonValue({ password: "local" }, object));
    strict.ok(!validateJsonValue({ password: "local", extra: 1 }, object));
    const tuple = jsonShapeFromSchema({
      type: "array",
      prefixItems: [{ type: "string" }, { enum: [1, 2] }],
      items: false,
      minItems: 2,
    });
    strict.ok(validateJsonValue(["x", 1], tuple));
    strict.ok(!validateJsonValue(["x", 3], tuple));
    strict.ok(!validateJsonValue(["x"], tuple));
  });
  await it("persists declarations in schema artifacts and includes them in identity", () => {
    const declaration = parseJsonDeclaration({
      source: "application",
      shape: jsonShapeFromSchema({
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      }),
    });
    const snapshot = {
      formatVersion: 1 as const,
      dialect: "sqlite",
      tables: {
        events: {
          name: "events",
          columns: {
            payload: {
              name: "payload",
              databaseType: "TEXT",
              tsType: "string",
              nullable: false,
              jsonDeclaration: declaration,
            },
          },
        },
      },
    };
    const parsed = parseSchemaSnapshot(JSON.parse(JSON.stringify(snapshot)));
    strict.deepEqual(parsed.tables.events?.columns.payload?.jsonDeclaration, declaration);
    const upgraded = parseSchemaSnapshot(JSON.parse(JSON.stringify(upgradeSchemaSnapshotV1(snapshot))));
    strict.deepEqual(upgraded.tables.events?.columns.payload?.jsonDeclaration, declaration);
    const without = {
      ...snapshot,
      tables: {
        events: {
          ...snapshot.tables.events,
          columns: { payload: { ...snapshot.tables.events.columns.payload, jsonDeclaration: undefined } },
        },
      },
    };
    strict.notEqual(calculateSchemaHash(parsed), calculateSchemaHash(without));
    strict.throws(() => parseJsonDeclaration({ shape: { kind: "unknown" }, source: "trusted" }), /source/);
  });
});
