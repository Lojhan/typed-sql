import { describe, it, strict } from "poku";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import { postgresCatalogCanCast, postgresCatalogCast, postgresCatalogType } from "../src/catalog/index.js";
import {
  postgresCanCoerce,
  postgresCanonicalType,
  postgresCommonType,
  resolvePostgresCandidates,
  resolvePostgresOperator,
  resolvePostgresUnaryOperator,
} from "../src/type-resolution.js";

const structuralSchema = (() => {
  const upgraded = upgradeSchemaSnapshotV1({ formatVersion: 1, dialect: "postgres", tables: {} });
  return {
    ...upgraded,
    types: {
      integer: {
        kind: "scalar",
        name: "integer",
        identity: "pg:23",
        databaseType: "integer",
        tsType: "number",
      },
      positive: {
        kind: "domain",
        name: "positive",
        identity: "pg:positive",
        databaseType: "positive",
        tsType: "number",
        baseTypeIdentity: "pg:23",
        nullable: false,
        checks: [],
      },
      mood: {
        kind: "enum",
        name: "mood",
        identity: "pg:mood",
        databaseType: "mood",
        tsType: '"happy" | "sad"',
        labels: ["happy", "sad"],
      },
      integers: {
        kind: "collection",
        name: "integers",
        identity: "pg:1007",
        databaseType: "integers",
        tsType: "readonly number[]",
        elementTypeIdentity: "pg:23",
      },
      integer_range: {
        kind: "range",
        name: "integer_range",
        identity: "pg:3904",
        databaseType: "integer_range",
        tsType: "unknown",
        subtypeIdentity: "pg:23",
      },
      integer_multirange: {
        kind: "multirange",
        name: "integer_multirange",
        identity: "pg:4451",
        databaseType: "integer_multirange",
        tsType: "unknown",
        subtypeIdentity: "pg:23",
      },
    },
  } as const satisfies SchemaSnapshot;
})();

await describe("PostgreSQL type resolution", async () => {
  await it("uses canonical type identities and cast contexts", () => {
    strict.strictEqual(postgresCanonicalType("INT4"), "integer");
    strict.strictEqual(postgresCanonicalType("character varying(40)"), "varchar");
    strict.strictEqual(postgresCanonicalType("INT8[]"), "bigint[]");
    strict.strictEqual(postgresCatalogType("float8")?.preferred, true);
    strict.strictEqual(postgresCatalogCast("int4", "numeric")?.context, "implicit");
    strict.strictEqual(postgresCatalogCast("integer", "made_up"), undefined);
    strict.strictEqual(postgresCatalogCanCast("integer", "numeric", "implicit"), true);
    strict.strictEqual(postgresCatalogCanCast("numeric", "integer", "implicit"), false);
    strict.strictEqual(postgresCatalogCanCast("numeric", "integer", "assignment"), true);
    strict.strictEqual(postgresCanCoerce("integer[]", "numeric[]", "implicit"), true);
    strict.strictEqual(postgresCanCoerce("uuid", "text", "assignment"), true);
    strict.strictEqual(postgresCanCoerce("text", "uuid", "explicit"), true);
    strict.strictEqual(postgresCanCoerce("text", "uuid", "assignment"), false);
    strict.strictEqual(postgresCanCoerce("uuid", "text", "implicit"), false);
    strict.strictEqual(postgresCanCoerce("boolean", "date", "explicit"), false);
  });

  await it("selects common types without allowing reverse narrowing", () => {
    strict.strictEqual(postgresCommonType(["integer", "bigint"]), "bigint");
    strict.strictEqual(postgresCommonType(["integer", "numeric"]), "numeric");
    strict.strictEqual(postgresCommonType(["varchar", "text"]), "varchar");
    strict.strictEqual(postgresCommonType(["text", "varchar"]), "text");
    strict.strictEqual(postgresCommonType([undefined, undefined]), "text");
    strict.strictEqual(postgresCommonType(["integer", "text"]), undefined);
  });

  await it("ranks exact, preferred, unknown, and polymorphic candidates", () => {
    const values = [
      { value: "integer", argumentTypes: ["integer"], resultType: "integer" },
      { value: "numeric", argumentTypes: ["numeric"], resultType: "numeric" },
      { value: "text", argumentTypes: ["text"], resultType: "text" },
    ] as const;
    const exact = resolvePostgresCandidates(values, ["integer"]);
    strict.strictEqual(exact.kind, "selected");
    strict.strictEqual(exact.kind === "selected" ? exact.candidate : undefined, "integer");
    const unknown = resolvePostgresCandidates(values, [undefined]);
    strict.strictEqual(unknown.kind, "selected");
    strict.strictEqual(unknown.kind === "selected" ? unknown.candidate : undefined, "text");

    const compatible = resolvePostgresCandidates(
      [{ value: "make_array", argumentTypes: ["anycompatible", "anycompatible"], resultType: "anycompatiblearray" }],
      ["integer", "numeric"],
    );
    strict.strictEqual(compatible.kind, "selected");
    strict.strictEqual(compatible.kind === "selected" ? compatible.resultType : undefined, "numeric[]");

    const simple = resolvePostgresCandidates(
      [{ value: "element", argumentTypes: ["anyarray"], resultType: "anyelement" }],
      ["integer[]"],
    );
    strict.strictEqual(simple.kind, "selected");
    strict.strictEqual(simple.kind === "selected" ? simple.resultType : undefined, "integer");
    strict.strictEqual(
      resolvePostgresCandidates(
        [{ value: "same", argumentTypes: ["anyelement", "anyelement"], resultType: "boolean" }],
        ["integer", "numeric"],
      ).kind,
      "none",
    );
    strict.strictEqual(
      resolvePostgresCandidates(
        [
          { value: "first", argumentTypes: ["integer"], resultType: "integer" },
          { value: "second", argumentTypes: ["integer"], resultType: "integer" },
        ],
        ["integer"],
      ).kind,
      "ambiguous",
    );
    const assumedKnown = resolvePostgresCandidates(
      [
        { value: "same", argumentTypes: ["integer", "integer"], resultType: "integer" },
        { value: "wider", argumentTypes: ["integer", "numeric"], resultType: "numeric" },
      ],
      ["integer", undefined],
    );
    strict.strictEqual(assumedKnown.kind === "selected" ? assumedKnown.candidate : assumedKnown.kind, "same");
    strict.strictEqual(
      resolvePostgresCandidates([{ value: "wrong-arity", argumentTypes: [], resultType: "integer" }], ["integer"]).kind,
      "none",
    );
  });

  await it("selects typed numeric, string, JSON, array, and comparison operators", () => {
    const selectedResult = (operator: string, left?: string, right?: string) => {
      const result = resolvePostgresOperator(operator, left, right);
      return result.kind === "selected" ? result.resultType : result.kind;
    };
    strict.strictEqual(selectedResult("+", "integer", "integer"), "integer");
    strict.strictEqual(selectedResult("+", "integer", "numeric"), "numeric");
    strict.strictEqual(selectedResult("+", "integer", "real"), "double precision");
    strict.strictEqual(selectedResult("^", "smallint", "smallint"), "double precision");
    strict.strictEqual(selectedResult("%", "double precision", "double precision"), "none");
    strict.strictEqual(selectedResult("+", "text", "integer"), "none");
    strict.strictEqual(selectedResult("||", "text", "varchar"), "text");
    strict.strictEqual(selectedResult("||", "integer[]", "numeric[]"), "numeric[]");
    strict.strictEqual(selectedResult("||", "integer", "integer[]"), "integer[]");
    strict.strictEqual(selectedResult("->", "jsonb", "integer"), "jsonb");
    strict.strictEqual(selectedResult("->>", "jsonb", undefined), "text");
    strict.strictEqual(selectedResult("#>", "json", "text[]"), "json");
    strict.strictEqual(selectedResult("#>>", "json", "text[]"), "text");
    strict.strictEqual(selectedResult("AND", "boolean", "boolean"), "boolean");
    strict.strictEqual(selectedResult("LIKE", "varchar", "text"), "boolean");
    strict.strictEqual(selectedResult("?", "jsonb", "text"), "boolean");
    strict.strictEqual(selectedResult("?&", "jsonb", "text[]"), "boolean");
    strict.strictEqual(selectedResult("@>", "integer[]", "integer[]"), "boolean");
    strict.strictEqual(selectedResult("<@", "jsonb", "jsonb"), "boolean");
    strict.strictEqual(selectedResult("&&", "integer[]", "integer[]"), "boolean");
    strict.strictEqual(selectedResult("&&", "jsonb", "jsonb"), "none");
    strict.strictEqual(selectedResult("=", "uuid", "uuid"), "boolean");
    strict.strictEqual(selectedResult("!!", "integer", "integer"), "none");
    strict.strictEqual(selectedResult("&", "integer", "integer"), "integer");
    strict.strictEqual(selectedResult("|", "smallint", "integer"), "integer");
    strict.strictEqual(selectedResult("#", "text", "text"), "none");
    strict.strictEqual(selectedResult("&", "bit", "bit"), "bit");
    strict.strictEqual(selectedResult("&", "varbit", "varbit"), "bit");
    strict.strictEqual(selectedResult("||", "varbit", "varbit"), "varbit");
    strict.strictEqual(selectedResult("||", "bit", "bit"), "varbit");
    strict.strictEqual(selectedResult("<<", "varbit", "integer"), "bit");
    strict.strictEqual(selectedResult("<<", "bigint", "integer"), "bigint");
    strict.strictEqual(selectedResult("<<", "bigint", "bigint"), "none");
    strict.strictEqual(selectedResult("||", "bytea", "bytea"), "bytea");
    strict.strictEqual(selectedResult("||", "jsonb", "jsonb"), "jsonb");
    strict.strictEqual(selectedResult("||", "text", "integer"), "text");
    strict.strictEqual(selectedResult("=", "inet", "cidr"), "boolean");
    strict.strictEqual(selectedResult("=", "int4range", "int4range"), "boolean");
    strict.strictEqual(selectedResult("<", "interval", "interval"), "boolean");
    strict.strictEqual(selectedResult("+", "oid", "oid"), "none");
    strict.strictEqual(selectedResult("+", "date", "integer"), "date");
    strict.strictEqual(selectedResult("-", "date", "date"), "integer");
    strict.strictEqual(selectedResult("-", "timestamp", "timestamp"), "interval");
    strict.strictEqual(selectedResult("+", "interval", "timestamptz"), "timestamptz");
    strict.strictEqual(selectedResult("*", "interval", "numeric"), "interval");
    strict.strictEqual(selectedResult("/", "interval", "double precision"), "interval");
    strict.strictEqual(selectedResult("+", "date", undefined), "ambiguous");
    strict.strictEqual(selectedResult("<<", "cidr", "inet"), "boolean");
    strict.strictEqual(selectedResult("&", "inet", "inet"), "inet");
    strict.strictEqual(selectedResult("+", "inet", "bigint"), "inet");
    strict.strictEqual(selectedResult("-", "inet", "inet"), "bigint");
    strict.strictEqual(selectedResult("+", "money", "money"), "money");
    strict.strictEqual(selectedResult("*", "real", "money"), "money");
    strict.strictEqual(selectedResult("/", "money", "money"), "double precision");
    strict.strictEqual(selectedResult("+", "numeric", "pg_lsn"), "pg_lsn");
    strict.strictEqual(selectedResult("-", "pg_lsn", "pg_lsn"), "numeric");
    strict.strictEqual(selectedResult("<", "tid", "tid"), "boolean");
    strict.strictEqual(selectedResult("@>", "int4range", "integer"), "boolean");
    strict.strictEqual(selectedResult("<@", "integer", "int4multirange"), "boolean");
    strict.strictEqual(selectedResult("&&", "int4range", "int4multirange"), "boolean");
    strict.strictEqual(selectedResult("-|-", "numrange", "nummultirange"), "boolean");
    strict.strictEqual(selectedResult("+", "int8range", "int8range"), "int8range");
    strict.strictEqual(selectedResult("*", "int8multirange", "int8multirange"), "int8multirange");
    strict.strictEqual(selectedResult("@@", "tsvector", "tsquery"), "boolean");
    strict.strictEqual(selectedResult("&&", "tsquery", "tsquery"), "tsquery");
    strict.strictEqual(selectedResult("||", "tsvector", "tsvector"), "tsvector");
    strict.strictEqual(selectedResult("@?", "jsonb", "jsonpath"), "boolean");
    strict.strictEqual(selectedResult("#-", "jsonb", "text[]"), "jsonb");
    strict.strictEqual(selectedResult("+", "box", "point"), "box");
    strict.strictEqual(selectedResult("#", "lseg", "lseg"), "point");
    strict.strictEqual(selectedResult("##", "point", "line"), "point");
    strict.strictEqual(selectedResult("<->", "polygon", "circle"), "double precision");
    strict.strictEqual(selectedResult("@>", "circle", "point"), "boolean");
    strict.strictEqual(selectedResult("<@", "point", "path"), "boolean");
    strict.strictEqual(selectedResult("&&", "polygon", "polygon"), "boolean");
    strict.strictEqual(selectedResult("<<|", "point", "point"), "boolean");
    strict.strictEqual(selectedResult("<^", "point", "point"), "boolean");
    strict.strictEqual(selectedResult("?#", "lseg", "line"), "boolean");
    strict.strictEqual(selectedResult("?-|", "line", "line"), "boolean");
    strict.strictEqual(selectedResult("~=", "circle", "circle"), "boolean");
    strict.strictEqual(selectedResult("@>", "point", "circle"), "none");

    const unaryResult = (operator: string, operand?: string) => {
      const result = resolvePostgresUnaryOperator(operator, operand);
      return result.kind === "selected" ? result.resultType : result.kind;
    };
    strict.strictEqual(unaryResult("-", "integer"), "integer");
    strict.strictEqual(unaryResult("+", "numeric"), "numeric");
    strict.strictEqual(unaryResult("~", "bigint"), "bigint");
    strict.strictEqual(unaryResult("NOT", undefined), "boolean");
    strict.strictEqual(unaryResult("-", undefined), "ambiguous");
    strict.strictEqual(unaryResult("-", "text"), "none");
    strict.strictEqual(unaryResult("~", "inet"), "inet");
    strict.strictEqual(unaryResult("!!", "tsquery"), "tsquery");
    strict.strictEqual(unaryResult("@", "numeric"), "numeric");
    strict.strictEqual(unaryResult("|/", "integer"), "double precision");
    strict.strictEqual(unaryResult("||/", "double precision"), "double precision");
    strict.strictEqual(unaryResult("~", "varbit"), "bit");
    strict.strictEqual(unaryResult("@-@", "path"), "double precision");
    strict.strictEqual(unaryResult("@@", "box"), "point");
    strict.strictEqual(unaryResult("#", "polygon"), "integer");
    strict.strictEqual(unaryResult("?-", "line"), "boolean");
  });

  await it("binds snapshot domains, enums, collections, ranges, and multiranges", () => {
    strict.strictEqual(postgresCommonType(["positive", "integer"], structuralSchema), "integer");
    const select = (argumentType: string, resultType: string, actual: string) =>
      resolvePostgresCandidates(
        [{ value: "candidate", argumentTypes: [argumentType], resultType }],
        [actual],
        structuralSchema,
      );
    const collection = select("anyarray", "anyelement", "integers");
    strict.strictEqual(collection.kind === "selected" ? collection.resultType : collection.kind, "integer");
    const enumValue = select("anyenum", "anyelement", "mood");
    strict.strictEqual(enumValue.kind === "selected" ? enumValue.resultType : enumValue.kind, "mood");
    const range = select("anyrange", "anyelement", "integer_range");
    strict.strictEqual(range.kind === "selected" ? range.resultType : range.kind, "integer");
    const multirange = select("anymultirange", "anyelement", "integer_multirange");
    strict.strictEqual(multirange.kind === "selected" ? multirange.resultType : multirange.kind, "integer");
    const compatibleRange = resolvePostgresCandidates(
      [
        {
          value: "candidate",
          argumentTypes: ["anycompatible", "anycompatiblerange"],
          resultType: "anycompatiblerange",
        },
      ],
      ["integer", "integer_range"],
      structuralSchema,
    );
    strict.strictEqual(
      compatibleRange.kind === "selected" ? compatibleRange.resultType : compatibleRange.kind,
      "integer_range",
    );
    strict.strictEqual(select("anynonarray", "anyelement", "integers").kind, "none");
    strict.strictEqual(select("anycompatiblenonarray", "anycompatible", "integers").kind, "none");
  });
});
