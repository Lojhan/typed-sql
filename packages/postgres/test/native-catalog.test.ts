import { describe, it, strict } from "poku";
import { postgresNativeArguments, postgresNativeOverloads } from "../src/catalog/native.js";
import { defaultPostgresTypePolicy, postgres } from "../src/index.js";

const schema = { formatVersion: 1, dialect: "postgres", version: "18.6", tables: {} } as const;
const grammar = postgres();
const overload = (name: string) => postgresNativeOverloads(name, schema)[0]!;

await describe("generated PostgreSQL native catalogs", async () => {
  await it("resolves captured scalar overloads, parameters and source spans with grammar-owned decoding policy", () => {
    const sql = "SELECT lpad($2, $1, $3) AS padded, round(3.25::numeric, 1) AS rounded, abs(42) AS magnitude";
    const result = grammar.analyze(sql, schema);
    strict.deepEqual(result.diagnostics, []);
    strict.deepEqual(
      result.columns.map(({ name, tsType, databaseType, nullable }) => ({ name, tsType, databaseType, nullable })),
      [
        { name: "padded", tsType: "string", databaseType: "text", nullable: true },
        { name: "rounded", tsType: "string", databaseType: "numeric", nullable: true },
        { name: "magnitude", tsType: "number", databaseType: "integer", nullable: true },
      ],
    );
    strict.deepEqual(result.parameters, [
      { index: 1, tsType: "number", databaseType: "integer", nullable: true },
      { index: 2, tsType: "string", databaseType: "text", nullable: true },
      { index: 3, tsType: "string", databaseType: "text", nullable: true },
    ]);
    strict.deepEqual(
      result.columns.map(({ range }) => sql.slice(range.start, range.end)),
      ["lpad($2, $1, $3) AS padded", "round(3.25::numeric, 1) AS rounded", "abs(42) AS magnitude"],
    );
    const alternate = postgres({ typePolicy: { ...defaultPostgresTypePolicy, numeric: "number" } });
    strict.equal(alternate.analyze("SELECT round(3.25::numeric, 1) AS value", schema).columns[0]!.tsType, "number");
    const constructors = grammar.analyze("SELECT pg_catalog.text($1) AS label, int4('2') AS amount", schema);
    strict.deepEqual(constructors.diagnostics, []);
    strict.deepEqual(
      constructors.parameters.map(({ index, databaseType }) => ({ index, databaseType })),
      [{ index: 1, databaseType: "text" }],
    );
    strict.deepEqual(
      constructors.columns.map(({ tsType }) => tsType),
      ["string", "number"],
    );
  });

  await it("retains nullable results and refuses invalid, opaque, qualified, ambiguous or unsupported invocations", () => {
    for (const sql of [
      "SELECT lower(1) AS value",
      "SELECT lower('x') OVER () AS value",
      "SELECT lower('x') WITHIN GROUP (ORDER BY 1) AS value",
      "SELECT concat() AS value",
      "SELECT concat($1) AS value",
      "SELECT pg_control_system() AS value",
      "SELECT public.lower('x') AS value",
      "SELECT \"LOWER\"('x') AS value",
      "SELECT int4in($1) AS value",
      "SELECT int4($1) AS value",
    ]) {
      const result = grammar.analyze(sql, schema);
      strict.ok(result.diagnostics.length, sql);
      strict.ok(
        result.columns.every((column) => column.tsType !== "any"),
        sql,
      );
      for (const diagnostic of result.diagnostics)
        strict.ok(diagnostic.range.start >= 0 && diagnostic.range.end <= sql.length, sql);
    }
    const valid = grammar.analyze("SELECT concat('x', NULL, 2) AS combined, lower(NULL::text) AS absent", schema);
    strict.deepEqual(valid.diagnostics, []);
    strict.deepEqual(valid.parameters, []);
    strict.deepEqual(
      valid.columns.map(({ tsType, nullable }) => ({ tsType, nullable })),
      [
        { tsType: "string", nullable: true },
        { tsType: "string", nullable: true },
      ],
    );
  });

  await it("uses actual version and namespace evidence without case-folding quoted function names", () => {
    strict.ok(postgresNativeOverloads("lower", schema).length);
    strict.ok(postgresNativeOverloads("lower", schema, "pg_catalog").length);
    strict.equal(postgresNativeOverloads("lower", schema, "public").length, 0);
    strict.equal(postgresNativeOverloads("LOWER", schema).length, 0);
    strict.equal(postgresNativeOverloads("lower", { ...schema, version: "unknown" }).length, 0);
    strict.equal(postgresNativeOverloads("lower", { ...schema, version: "99.0" }).length, 0);
    const { version: _version, ...unversioned } = schema;
    strict.ok(postgresNativeOverloads("lower", unversioned).length);
    strict.equal(postgresNativeOverloads("crc32c", { ...schema, version: "17.11" }).length, 0);
    strict.ok(postgresNativeOverloads("crc32c", schema).length);
  });

  await it("binds defaults, named parameters, input/output modes and variadics from native facts", () => {
    const lower = postgresNativeOverloads("lower", schema).find(
      (signature) => signature.arguments[0]?.nativeType === "text",
    )!;
    strict.deepEqual(postgresNativeArguments(lower, ["text"]), ["text"]);
    strict.equal(postgresNativeArguments(lower, []), undefined);
    strict.equal(postgresNativeArguments(lower, ["text", "text"]), undefined);
    strict.equal(postgresNativeArguments(lower, ["text"], undefined, true), undefined);
    const interval = overload("make_interval");
    strict.deepEqual(postgresNativeArguments(interval, []), []);
    strict.deepEqual(postgresNativeArguments(interval, ["integer"], ["days"]), ["integer"]);
    strict.equal(postgresNativeArguments(interval, ["integer"], []), undefined);
    strict.equal(postgresNativeArguments(interval, ["integer"], ["nonexistent"]), undefined);
    strict.equal(postgresNativeArguments(interval, ["integer", "integer"], ["days", "days"]), undefined);
    strict.equal(postgresNativeArguments(interval, ["integer", "integer"], ["days", undefined]), undefined);
    const makeDate = overload("make_date");
    strict.equal(postgresNativeArguments(makeDate, ["integer"], ["year"]), undefined);
    const concat = overload("concat");
    strict.deepEqual(postgresNativeArguments(concat, ["text", "integer"]), ["text", "integer"]);
    strict.equal(postgresNativeArguments(concat, []), undefined);
    strict.equal(postgresNativeArguments(concat, [undefined]), undefined);
    strict.equal(postgresNativeArguments(concat, ["text"], undefined, true), undefined);
    strict.equal(postgresNativeArguments(concat, ["text", "text"], undefined, true), undefined);
    strict.deepEqual(postgresNativeArguments(concat, ["text[]"], undefined, true), ["text[]"]);
    strict.equal(postgresNativeArguments(concat, ["text"], [undefined]), undefined);
    strict.equal(postgresNativeArguments({ ...concat, variadicNativeType: null }, ["text"]), undefined);
    const jsonPath = overload("jsonb_extract_path");
    strict.deepEqual(postgresNativeArguments(jsonPath, ["jsonb", "text", "text"]), ["jsonb", "text", "text"]);
    strict.deepEqual(postgresNativeArguments(jsonPath, ["jsonb", "text[]"], undefined, true), ["jsonb", "text[]"]);
    strict.deepEqual(postgresNativeArguments(overload("pg_control_system"), []), []);
  });
});
