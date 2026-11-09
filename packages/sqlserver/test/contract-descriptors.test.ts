import { describe, it, strict } from "poku";
import { sqlServerContractColumns, sqlServerContractParameters } from "../src/contract-descriptors.js";
import { defaultSqlServerTypePolicy } from "../src/type-policy.js";

const column = (changes: Record<string, unknown> = {}) => ({
  is_hidden: 0,
  column_ordinal: 1,
  name: "value",
  system_type_name: "int",
  system_type_id: 56,
  user_type_id: null,
  user_type_name: null,
  assembly_qualified_type_name: null,
  is_nullable: 0,
  collation_name: null,
  error_number: null,
  error_type: null,
  ...changes,
});
const parameter = (changes: Record<string, unknown> = {}) => ({
  parameter_ordinal: 1,
  name: "@__typed_sql_1",
  suggested_system_type_name: "int",
  suggested_system_type_id: 56,
  suggested_user_type_id: null,
  suggested_user_type_name: null,
  suggested_assembly_qualified_type_name: null,
  suggested_is_input: 1,
  suggested_is_output: 0,
  ...changes,
});
const field = (changes: Record<string, unknown> = {}) => sqlServerContractColumns([column(changes)])[0]!;

await describe("independent SQL Server contract descriptor facets", async () => {
  await it("preserves dimensions, collations and conservative nullable evidence", () => {
    const value = field({
      system_type_name: "nvarchar(32)",
      system_type_id: 231,
      max_length: 64,
      precision: 0,
      scale: 0,
      collation_name: "Latin1_General_100_CI_AS_SC_UTF8",
      is_nullable: 1,
    });
    strict.deepEqual(value.nativeType, {
      status: "known",
      value: { name: "nvarchar(32) COLLATE Latin1_General_100_CI_AS_SC_UTF8", complete: true },
    });
    strict.deepEqual(value.runtimeType, { status: "known", value: "string" });
    strict.deepEqual(value.nullable, { status: "known", value: true, precision: "upper-bound" });
    strict.equal(value.descriptor.maxLength, 64);
    strict.deepEqual(field().nullable, { status: "known", value: false, precision: "exact" });
    strict.deepEqual(field({ is_nullable: null }).nullable, {
      status: "unknown",
      reason: "native-nullability-unavailable",
    });
    strict.deepEqual(
      field({ system_type_name: "decimal(38,10)", system_type_id: 106, max_length: 17, precision: 38, scale: 10 })
        .runtimeType,
      { status: "known", value: "string" },
    );
    strict.deepEqual(field({ system_type_name: "datetime2(7)", system_type_id: 42, scale: 7 }).nativeType, {
      status: "known",
      value: { name: "datetime2(7)", complete: true },
    });
    strict.equal(
      field({
        system_type_name: "nvarchar(max)",
        system_type_id: 231,
        max_length: -1,
        collation_name: "Latin1_General_100_CI_AS",
      }).descriptor.maxLength,
      -1,
    );
  });
  await it("does not promote omitted identity metadata, aliases, CLR values, typed XML or opaque types", () => {
    const { user_type_id: _alias, ...omitted } = column();
    strict.deepEqual(sqlServerContractColumns([omitted])[0]!.nativeType, {
      status: "known",
      value: { name: "int", complete: false },
    });
    strict.deepEqual(field({ user_type_id: 256, user_type_name: "alias_integer" }).nativeType, {
      status: "known",
      value: { name: "int", complete: false },
    });
    const qualified = field({
      user_type_id: 256,
      user_type_name: "alias_integer",
      user_type_database: "application",
      user_type_schema: "types",
      is_case_sensitive: 0,
    });
    const document = field({
      system_type_name: "xml",
      system_type_id: 241,
      xml_collection_id: 12,
      xml_collection_database: "application",
      xml_collection_schema: "types",
      xml_collection_name: "document",
      is_xml_document: 1,
      is_fixed_length_clr_type: 0,
    });
    strict.equal(qualified.descriptor.userTypeDatabase, "application");
    strict.equal(qualified.descriptor.userTypeSchema, "types");
    strict.equal(document.descriptor.xmlCollectionName, "document");
    strict.equal(document.descriptor.xmlDocument, true);
    strict.equal(qualified.descriptor.caseSensitive, false);
    strict.deepEqual(
      field({
        system_type_name: null,
        system_type_id: 240,
        user_type_id: 257,
        user_type_name: "custom",
        assembly_qualified_type_name: "Vendor.Custom, Vendor",
      }).runtimeType,
      { status: "unknown", reason: "native-runtime-representation-unavailable" },
    );
    strict.deepEqual(field({ system_type_name: "sql_variant", system_type_id: 98 }).runtimeType, {
      status: "unknown",
      reason: "native-runtime-representation-unavailable",
    });
    strict.deepEqual(field({ system_type_name: "xml", system_type_id: 241, xml_collection_id: 12 }).nativeType, {
      status: "known",
      value: { name: "xml", complete: false },
    });
    strict.deepEqual(
      field({ system_type_name: "xml", system_type_id: 241, xml_collection_id: null, is_xml_document: 0 }).nativeType,
      {
        status: "known",
        value: { name: "xml", complete: true },
      },
    );
    strict.equal(
      field({ system_type_name: "varchar", system_type_id: 167, max_length: 32 }).nativeType.status,
      "unknown",
    );
    strict.equal(field({ system_type_name: "datetime2", system_type_id: 42, scale: 3 }).nativeType.status, "unknown");
    strict.equal(field({ system_type_name: "nvarchar(32)", system_type_id: 231 }).nativeType.status, "known");
    strict.deepEqual(field({ system_type_name: "nvarchar(32)", system_type_id: 231 }).nativeType, {
      status: "known",
      value: { name: "nvarchar(32)", complete: false },
    });
  });
  await it("selects runtime representations from the same type policy without inventing unsupported codecs", () => {
    const cases = [
      ["bigint", 127, "bigint"],
      ["decimal(38,10)", 106, "string"],
      ["varbinary(max)", 165, "bytes"],
      ["bit", 104, "boolean"],
      ["datetimeoffset(7)", 43, "string"],
    ] as const;
    for (const [name, id, expected] of cases)
      strict.deepEqual(field({ system_type_name: name, system_type_id: id }).runtimeType, {
        status: "known",
        value: expected,
      });
    const policy = {
      ...defaultSqlServerTypePolicy,
      bigint: "number" as const,
      decimal: "number" as const,
      temporal: "Date" as const,
    };
    const values = sqlServerContractColumns(
      [
        column({ system_type_name: "bigint", system_type_id: 127 }),
        column({ column_ordinal: 2, name: "decimal", system_type_name: "decimal(10,2)", system_type_id: 106 }),
        column({ column_ordinal: 3, name: "time", system_type_name: "datetime2(7)", system_type_id: 42 }),
      ],
      policy,
    );
    strict.deepEqual(
      values.map(({ runtimeType }) => runtimeType),
      [
        { status: "known", value: "number" },
        { status: "known", value: "number" },
        { status: "known", value: "date" },
      ],
    );
    strict.equal(
      sqlServerContractColumns([column({ system_type_name: "decimal(10,2)", system_type_id: 106 })], {
        ...defaultSqlServerTypePolicy,
        decimal: "Decimal",
      })[0]!.runtimeType.status,
      "unknown",
    );
  });
  await it("keeps native parameter ordinals separate from canonical argument slots and declaration text", () => {
    const result = sqlServerContractParameters(
      [
        parameter({
          name: "@__typed_sql_2",
          parameter_ordinal: 1,
          suggested_system_type_name: "bigint",
          suggested_system_type_id: 127,
          formal_parameter_name: "value",
        }),
        parameter({
          name: "@__typed_sql_1",
          parameter_ordinal: 2,
          suggested_system_type_name: "nvarchar(32)",
          suggested_system_type_id: 231,
          suggested_max_length: 64,
        }),
      ],
      [1, 2],
    );
    strict.equal(result.declarations, "@__typed_sql_1 nvarchar(32), @__typed_sql_2 bigint");
    strict.deepEqual(
      result.parameters.map(({ index }) => index),
      [1, 2],
    );
    strict.equal(result.parameters[0]!.descriptor.nativeOrdinal, 2);
    strict.equal(result.parameters[1]!.descriptor.formalParameterName, "value");
    strict.deepEqual(result.parameters[0]!.nativeType, {
      status: "known",
      value: { name: "nvarchar(32)", complete: false },
    });
    strict.deepEqual(result.parameters[0]!.nullable, { status: "known", value: true, precision: "upper-bound" });
    strict.deepEqual(sqlServerContractParameters([], []), { parameters: [], declarations: "" });
  });
  await it("rejects conflicting native dimensions, malformed metadata, ambiguous results and unsafe declarations", () => {
    for (const changes of [
      { system_type_name: "nvarchar(32)", system_type_id: 231, max_length: 32 },
      { system_type_name: "decimal(38,10)", precision: 18, scale: 10 },
      { system_type_name: "decimal(38,10)", precision: 38, scale: 2 },
      { system_type_name: "datetime2(7)", scale: 3 },
      { system_type_name: "int", collation_name: "Latin1_General_100_CI_AS" },
      { xml_collection_id: 12 },
      { is_nullable: "unknown" },
      { is_hidden: null },
      { column_ordinal: 2 },
      { name: null },
      { system_type_id: -1 },
      { system_type_id: 0 },
      { user_type_id: 0 },
      { error_number: 11509 },
      { error_type: 4 },
      { max_length: -2 },
    ])
      strict.throws(() => field(changes), TypeError);
    strict.throws(() => sqlServerContractColumns([]), TypeError);
    strict.throws(() => sqlServerContractColumns([column({ is_hidden: 1 })]), TypeError);
    strict.throws(() => sqlServerContractColumns([column(), column({ column_ordinal: 2 })]), TypeError);
    for (const changes of [
      { name: "@other" },
      { parameter_ordinal: 0 },
      { suggested_is_input: 0 },
      { suggested_is_output: 1 },
      { suggested_system_type_name: "int; DROP TABLE users" },
      { suggested_system_type_name: "nvarchar(32) COLLATE Latin1_General_100_CI_AS" },
      { suggested_user_type_id: 256, suggested_user_type_name: "alias_integer" },
      { suggested_system_type_name: "sql_variant" },
      { suggested_user_type_id: undefined },
      { error_number: 11509 },
    ])
      strict.throws(() => sqlServerContractParameters([parameter(changes)], [1]), TypeError);
    strict.throws(
      () => sqlServerContractParameters([parameter(), parameter({ name: "@__typed_sql_2" })], [1, 2]),
      TypeError,
    );
    strict.throws(() => sqlServerContractParameters([parameter()], [2]), TypeError);
  });
  await it("requires data-only metadata and does not retain mutable native row objects", () => {
    const row = column();
    const result = sqlServerContractColumns([row]);
    row.system_type_name = "nvarchar(max)";
    strict.deepEqual(result[0]!.nativeType, { status: "known", value: { name: "int", complete: true } });
    let reads = 0;
    const accessor = Object.defineProperty(column(), "name", {
      enumerable: true,
      get() {
        reads++;
        return "value";
      },
    });
    strict.throws(() => sqlServerContractColumns([accessor]), TypeError);
    strict.equal(reads, 0);
  });
});
