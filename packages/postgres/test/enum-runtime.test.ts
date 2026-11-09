import {
  decodeQueryResultRows,
  encodeQueryValues,
  type RuntimeValueType,
  sql,
  withQueryValuePlan,
} from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { buildQueryValuePlan } from "../../compiler/src/index.js";
import {
  calculateTypePolicyHash,
  defineSchemaSnapshotV2,
  serializeSchemaSnapshot,
  upgradeSchemaSnapshotV1,
} from "../../schema/src/index.js";
import { postgres, postgresServerEvidence } from "../src/analysis.js";
import { postgresEnumRuntimeType } from "../src/enum-runtime.js";
import { normalizePostgresValue } from "../src/query.js";
import { createPostgresDatabase } from "../src/runtime.js";
import { defaultPostgresTypePolicy } from "../src/type-policy.js";

const labels = ["happy", "sad"] as const;
const expected = { union: labels.map((literal) => ({ literal })) };
function fixture(version: 1 | 2, enums: "string" | "string-union" = "string-union") {
  const dialect = postgres({ typePolicy: { ...defaultPostgresTypePolicy, enums } });
  const scalar = enums === "string" ? "string" : labels.map((label) => JSON.stringify(label)).join(" | ");
  const legacy = {
    formatVersion: 1,
    dialect: "postgres",
    dialectVersion: dialect.grammarVersion,
    server: postgresServerEvidence("18.3"),
    enums: { mood: labels },
    functions: {
      "public.current_mood()": {
        schema: "public",
        name: "current_mood",
        argumentTypes: [],
        databaseReturnType: "mood",
        returnType: scalar,
        nullable: true,
      },
    },
    tables: {
      records: {
        name: "records",
        columns: {
          id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
          state: { name: "state", databaseType: "mood", tsType: scalar, nullable: false },
          states: { name: "states", databaseType: "mood[]", tsType: `readonly (${scalar} | null)[]`, nullable: false },
        },
      },
    },
  } as const;
  const upgraded = upgradeSchemaSnapshotV1(legacy);
  const schema =
    version === 1
      ? legacy
      : defineSchemaSnapshotV2({
          ...JSON.parse(serializeSchemaSnapshot(upgraded)),
          types: Object.fromEntries(
            Object.entries(upgraded.types).map(([key, type]) => [
              key,
              type.kind === "enum" ? { ...type, tsType: scalar } : type,
            ]),
          ),
        });
  return { schema: dialect.validateSnapshot(schema), dialect };
}

await describe("declared PostgreSQL enum codecs", async () => {
  await it("preserves declared labels in output, input, returning and nullable joins for both snapshot formats", () => {
    for (const version of [1, 2] as const) {
      const { schema, dialect } = fixture(version);
      const source =
        "SELECT r.state,s.state AS optional FROM records r LEFT JOIN records s ON s.id=r.id WHERE r.state=$1";
      const result = dialect.analyze(source, schema);
      strict.deepEqual(result.diagnostics, []);
      strict.deepEqual(
        result.columns.map(({ tsType }) => tsType),
        ['"happy" | "sad"', '"happy" | "sad"'],
      );
      strict.equal(source.slice(result.columns[0]!.range.start, result.columns[0]!.range.end), "r.state");
      strict.deepEqual(
        result.columns.map(({ runtimeType, nullable }) => ({ runtimeType, nullable })),
        [
          { runtimeType: expected, nullable: false },
          { runtimeType: expected, nullable: true },
        ],
      );
      strict.deepEqual(
        result.parameters.map(({ index, runtimeType }) => ({ index, runtimeType })),
        [{ index: 1, runtimeType: expected }],
      );
      const write = dialect.analyze(
        "INSERT INTO records(id,state,states) VALUES($1,$2,$3) RETURNING state,states",
        schema,
      );
      strict.deepEqual(write.diagnostics, []);
      strict.deepEqual(
        write.columns.map(({ runtimeType }) => runtimeType),
        [expected, { array: expected, elementNullable: true }],
      );
      strict.deepEqual(
        write.parameters.map(({ runtimeType }) => runtimeType),
        [undefined, expected, { array: expected, elementNullable: true }],
      );
      const plan = buildQueryValuePlan(dialect, result);
      const query = withQueryValuePlan(sql`SELECT ${"happy"}`, plan);
      const profile = {
        id: "pg-enum-proof",
        dialect: "postgres",
        integer: "lossless" as const,
        jsonWire: "parsed" as const,
        typePolicyHash: plan.typePolicyHash,
        normalizeValue: normalizePostgresValue,
      };
      strict.deepEqual(encodeQueryValues(query, ["happy"], profile), ["happy"]);
      strict.throws(() => encodeQueryValues(query, ["not-declared"], profile));
      strict.deepEqual(decodeQueryResultRows(query, [{ state: "happy", optional: null }], profile), [
        { state: "happy", optional: null },
      ]);
      strict.throws(() => decodeQueryResultRows(query, [{ state: "new-label", optional: null }], profile));
      strict.throws(() => decodeQueryResultRows(query, [{ state: null, optional: null }], profile));
      const array = dialect.analyze("SELECT states FROM records WHERE states=$1", schema);
      const arrayPlan = buildQueryValuePlan(dialect, array),
        arrayQuery = withQueryValuePlan(sql`SELECT ${["happy", null]}`, arrayPlan);
      strict.deepEqual(
        encodeQueryValues(arrayQuery, [["happy", null]], { ...profile, typePolicyHash: arrayPlan.typePolicyHash }),
        [["happy", null]],
      );
      strict.deepEqual(decodeQueryResultRows(arrayQuery, [{ states: "{happy,NULL,sad}" }], profile), [
        { states: ["happy", null, "sad"] },
      ]);
      strict.throws(() => decodeQueryResultRows(arrayQuery, [{ states: "{not-declared}" }], profile));
      const conflicting = dialect.analyze("SELECT id FROM records WHERE state=$1 AND id=$1", schema);
      strict.equal(conflicting.parameters[0]?.tsType, "unknown");
      strict.equal(conflicting.parameters[0]?.runtimeType, undefined);
      const conditional = dialect.analyze(
        "SELECT CASE WHEN id>0 THEN state ELSE NULL END AS state,CASE WHEN id>0 THEN states ELSE NULL END AS states FROM records",
        schema,
      );
      strict.deepEqual(conditional.diagnostics, []);
      strict.ok(conditional.columns.every(({ tsType, nullable }) => tsType !== "unknown" && nullable));
      strict.deepEqual(
        conditional.columns.map(({ runtimeType }) => runtimeType),
        [{ union: [expected] }, { union: [{ array: expected, elementNullable: true }] }],
      );
      const unknownBranches = dialect.analyze(
        "SELECT CASE WHEN id>0 THEN NULL ELSE NULL END AS empty,CASE WHEN id>0 THEN state ELSE $1 END AS unresolved FROM records",
        schema,
      );
      strict.equal(unknownBranches.columns[0]?.tsType, "unknown");
      strict.equal(unknownBranches.columns[0]?.nullable, true);
      strict.equal(unknownBranches.columns[1]?.tsType, "unknown");
      strict.equal(unknownBranches.parameters[0]?.tsType, "unknown");
      const declared = dialect.analyze(
        "SELECT $1::mood AS state, $2::mood[] AS states, public.current_mood() AS selected",
        schema,
      );
      strict.deepEqual(declared.diagnostics, []);
      strict.deepEqual(
        declared.columns.map(({ runtimeType }) => runtimeType),
        [expected, { array: expected, elementNullable: true }, expected],
      );
      strict.deepEqual(
        declared.parameters.map(({ index, runtimeType }) => ({ index, runtimeType })),
        [
          { index: 1, runtimeType: expected },
          { index: 2, runtimeType: { array: expected, elementNullable: true } },
        ],
      );
    }
  });
  await it("uses the selected string policy without parsing type literals or tightening its allowed inputs", () => {
    for (const version of [1, 2] as const) {
      const { schema, dialect } = fixture(version, "string");
      const result = dialect.analyze("SELECT state,states FROM records WHERE state=$1", schema);
      strict.deepEqual(result.diagnostics, []);
      strict.deepEqual(
        result.columns.map(({ runtimeType }) => runtimeType),
        ["string", { array: "string", elementNullable: true }],
      );
      strict.equal(result.parameters[0]?.runtimeType, "string");
    }
  });
  await it("requires unambiguous enum evidence and preserves quoted identifier case", () => {
    const { schema } = fixture(2);
    if (schema.formatVersion !== 2) throw Error("Expected v2 fixture");
    const enumType = Object.values(schema.types).find((type) => type.kind === "enum")!;
    const declared = defineSchemaSnapshotV2({
      ...JSON.parse(serializeSchemaSnapshot(schema)),
      types: {
        first: { ...enumType, name: "Mood", schema: "app", identity: "pg:enum-first", databaseType: 'app."Mood"' },
        second: { ...enumType, name: "mood", schema: "other", identity: "pg:enum-second", databaseType: "other.mood" },
      },
    });
    strict.deepEqual(postgresEnumRuntimeType('app."Mood"', declared, defaultPostgresTypePolicy), expected);
    strict.equal(postgresEnumRuntimeType("app.mood", declared, defaultPostgresTypePolicy), undefined);
    strict.equal(postgresEnumRuntimeType("unknown", declared, defaultPostgresTypePolicy), undefined);
    strict.equal(postgresEnumRuntimeType("text", declared, defaultPostgresTypePolicy), undefined);
    const ambiguous = defineSchemaSnapshotV2({
      ...JSON.parse(serializeSchemaSnapshot(declared)),
      types: {
        a: { ...enumType, identity: "a", databaseType: "mood" },
        b: { ...enumType, identity: "b", databaseType: "mood" },
      },
    });
    strict.equal(postgresEnumRuntimeType("mood", ambiguous, defaultPostgresTypePolicy), undefined);
  });
  await it("retains empty/singleton enum facts and refuses malformed or non-enum identities", () => {
    const { schema } = fixture(1);
    const defined = {
      ...schema,
      formatVersion: 1 as const,
      tables: {},
      enums: { empty: [], singleton: ["only"], mood: labels },
    };
    strict.equal(postgresEnumRuntimeType("empty", defined, defaultPostgresTypePolicy), "never");
    strict.deepEqual(postgresEnumRuntimeType("singleton", defined, defaultPostgresTypePolicy), { literal: "only" });
    strict.deepEqual(postgresEnumRuntimeType("mood[][]", defined, defaultPostgresTypePolicy), {
      array: { array: expected, elementNullable: true },
      elementNullable: true,
    });
    for (const name of ["", "mood[", "a.b.c", "a+b", "123", "'mood'", '"unterminated'])
      strict.equal(postgresEnumRuntimeType(name, defined, defaultPostgresTypePolicy), undefined);
    const opaque = defineSchemaSnapshotV2({
      ...JSON.parse(serializeSchemaSnapshot(fixture(2).schema)),
      types: {
        opaque: {
          kind: "scalar",
          name: "opaque",
          identity: "opaque",
          databaseType: "opaque",
          tsType: '"happy" | "sad"',
        },
      },
    });
    strict.equal(postgresEnumRuntimeType("opaque", opaque, defaultPostgresTypePolicy), undefined);
  });
  await it("normalizes declared string-array text without guessing codecs for opaque arrays or scalar strings", async () => {
    let value: unknown = "{happy,NULL,sad}";
    const database = createPostgresDatabase({
      pool: {
        query: async () => ({ rows: [{ state: value }] }),
        connect: async () => {
          throw Error("Unexpected lease");
        },
        end: async () => {},
      },
    });
    const query = (type: RuntimeValueType, databaseType = "app.mood[]") =>
      withQueryValuePlan(sql`SELECT state`, {
        dialect: "postgres",
        typePolicyHash: calculateTypePolicyHash(defaultPostgresTypePolicy),
        columns: [{ name: "state", type, databaseType, nullable: false }],
        parameters: [],
      });
    try {
      strict.deepEqual(await database.all(query({ array: expected, elementNullable: true })), [
        { state: ["happy", null, "sad"] },
      ]);
      await strict.rejects(database.all(query({ array: "unknown", elementNullable: true })));
      strict.deepEqual(await database.all(query("string")), [{ state: value }]);
      strict.deepEqual(await database.all(query({ literal: "{happy,NULL,sad}" })), [{ state: value }]);
      strict.deepEqual(await database.all(query("string", "text")), [{ state: value }]);
      value = "{{happy,sad}}";
      strict.deepEqual(
        await database.all(query({ array: { array: expected, elementNullable: true }, elementNullable: true })),
        [{ state: [["happy", "sad"]] }],
      );
      value = "{happy}";
      strict.deepEqual(await database.all(query({ union: [{ array: expected, elementNullable: true }, "never"] })), [
        { state: ["happy"] },
      ]);
      value = "{not-declared}";
      await strict.rejects(database.all(query({ array: expected, elementNullable: true })));
    } finally {
      await database.close();
    }
  });
});
