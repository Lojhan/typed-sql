import {
  canonicalContractData,
  type NativeContractValueEvidence,
  type NativeQueryContractEvidence,
} from "@typed-sql/analysis";
import { parseSqlServerNativeType } from "./native-types.js";
import {
  defaultSqlServerTypePolicy,
  mapSqlServerType,
  type SqlServerTypePolicy,
  sqlServerRuntimeValueType,
  validateSqlServerTypePolicy,
} from "./type-policy.js";

type Row = Readonly<Record<string, unknown>>;
/** Service parameters bind transient candidate SQL as data; no candidate batch is executed. */
export const sqlServerContractDescriptionQueries = Object.freeze({
  parameters: "EXEC sys.sp_describe_undeclared_parameters @tsql = ?",
  columns:
    "SELECT is_hidden,column_ordinal,name,is_nullable,system_type_id,system_type_name,max_length,precision,scale,collation_name,user_type_id,user_type_database,user_type_schema,user_type_name,assembly_qualified_type_name,xml_collection_id,xml_collection_database,xml_collection_schema,xml_collection_name,is_xml_document,is_case_sensitive,is_fixed_length_clr_type,error_number,error_type FROM sys.dm_exec_describe_first_result_set(?, ?, 0) ORDER BY column_ordinal",
});
const snapshot = <Value>(value: Value): Value => JSON.parse(canonicalContractData(value));
const known = <Value>(value: Value) => ({ status: "known" as const, value });
const unknown = (reason: string) => ({ status: "unknown" as const, reason });
const text = (value: unknown, limit = 512): string => {
  if (typeof value !== "string" || !value.length || value.length > limit || value.includes("\0"))
    throw new TypeError("Invalid SQL Server native descriptor text");
  return value;
};
const integer = (value: unknown): number => {
  const result =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError("Invalid SQL Server native descriptor integer");
  return result;
};
const flag = (value: unknown): boolean => {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new TypeError("Invalid SQL Server native descriptor flag");
};
function scalar(row: Row, parameter: boolean, policy: SqlServerTypePolicy): NativeContractValueEvidence {
  const raw = parameter ? row.suggested_system_type_name : row.system_type_name;
  const parsed = typeof raw === "string" ? parseSqlServerNativeType(raw) : undefined;
  const alias = row[parameter ? "suggested_user_type_id" : "user_type_id"];
  const system = row[parameter ? "suggested_system_type_id" : "system_type_id"];
  const userName = row[parameter ? "suggested_user_type_name" : "user_type_name"];
  const assembly = row[parameter ? "suggested_assembly_qualified_type_name" : "assembly_qualified_type_name"];
  // Missing user-type metadata does not prove that the declared identity is a system type.
  const systemKnown = system !== null && system !== undefined;
  const aliasKnown = alias !== null && alias !== undefined;
  if ((systemKnown && integer(system) === 0) || (aliasKnown && integer(alias) === 0))
    throw new TypeError("Invalid SQL Server native type identity");
  const declaredUserType =
    (aliasKnown && systemKnown && integer(alias) !== integer(system)) || userName != null || assembly != null;
  const collation = parameter ? undefined : row.collation_name;
  let native = parsed;
  if (parsed && collation != null) native = parseSqlServerNativeType(`${parsed.text} COLLATE ${text(collation, 128)}`);
  // Some non-character fields have no collation. A malformed or inapplicable collation cannot be ignored.
  if (parsed && collation != null && !native) throw new TypeError("Invalid SQL Server native collation");
  const dimensionsPresent = Boolean(
    native &&
      (native.name === "float" ||
        (native.length === undefined && native.scale === undefined && native.precision === undefined) ||
        (typeof raw === "string" && raw.includes("("))),
  );
  const character = Boolean(native && ["varchar", "nvarchar", "char", "nchar", "text", "ntext"].includes(native.name));
  const xmlId = row[parameter ? "suggested_xml_collection_id" : "xml_collection_id"];
  const xmlDocument = row[parameter ? "suggested_is_xml_document" : "is_xml_document"];
  const xmlComplete =
    native?.name !== "xml" ||
    ((xmlId === null || xmlId === 0 || xmlId === "0") && xmlDocument != null && !flag(xmlDocument));
  if (
    native &&
    native.name !== "xml" &&
    ((xmlId != null && integer(xmlId) > 0) || (xmlDocument != null && flag(xmlDocument)))
  )
    throw new TypeError("SQL Server native XML identity contradicts the system type");
  const bindingIdentityKnown = Boolean(
    native &&
      dimensionsPresent &&
      systemKnown &&
      !declaredUserType &&
      (aliasKnown || alias === null) &&
      xmlComplete &&
      (!parameter || !native.collation),
  );
  const complete = bindingIdentityKnown && (!character || (!parameter && collation != null));
  const opaque = !native || native.name === "sql_variant" || assembly != null;
  const mapped = !native || opaque ? "unknown" : mapSqlServerType(native.text, policy);
  const runtime = sqlServerRuntimeValueType(
    { tsType: mapped, ...(native ? { databaseType: native.text } : {}), nullable: true },
    policy,
  );
  const declared = parameter ? row.suggested_is_input : row.is_nullable;
  if (parameter && (!flag(row.suggested_is_input) || flag(row.suggested_is_output)))
    throw new TypeError("SQL Server output parameter descriptions are not query inputs");
  const nullable: NativeContractValueEvidence["nullable"] = parameter
    ? { status: "known", value: true, precision: "upper-bound" }
    : declared == null
      ? unknown("native-nullability-unavailable")
      : flag(declared)
        ? { status: "known", value: true, precision: "upper-bound" }
        : { status: "known", value: false, precision: "exact" };
  const descriptor: Record<string, unknown> = {
    bindingIdentityKnown,
    source: parameter ? "sp_describe_undeclared_parameters" : "dm_exec_describe_first_result_set",
    ...(typeof raw === "string" ? { systemTypeName: text(raw) } : {}),
    ...(systemKnown ? { systemTypeId: integer(system) } : {}),
    ...(aliasKnown ? { userTypeId: integer(alias) } : {}),
    ...(userName != null ? { userTypeName: text(userName, 128) } : {}),
    ...(assembly != null ? { assemblyQualifiedTypeName: text(assembly, 4096) } : {}),
    ...(collation != null ? { collation: text(collation, 128) } : {}),
    ...(xmlId != null ? { xmlCollectionId: integer(xmlId) } : {}),
    ...(parameter && row.formal_parameter_name != null
      ? { formalParameterName: text(row.formal_parameter_name, 128) }
      : {}),
  };
  for (const [source, key] of [
    ["user_type_database", "userTypeDatabase"],
    ["user_type_schema", "userTypeSchema"],
    ["xml_collection_database", "xmlCollectionDatabase"],
    ["xml_collection_schema", "xmlCollectionSchema"],
    ["xml_collection_name", "xmlCollectionName"],
  ] as const) {
    const value = row[parameter ? `suggested_${source}` : source];
    if (value != null) descriptor[key] = text(value, 128);
  }
  for (const [source, key] of [
    ["is_xml_document", "xmlDocument"],
    ["is_case_sensitive", "caseSensitive"],
    ["is_fixed_length_clr_type", "fixedLengthClrType"],
  ] as const) {
    const value = row[parameter ? `suggested_${source}` : source];
    if (value != null) descriptor[key] = flag(value);
  }
  for (const [source, key] of [
    ["max_length", "maxLength"],
    ["precision", "precision"],
    ["scale", "scale"],
  ] as const) {
    const value = row[parameter ? `suggested_${source}` : source];
    if (value != null) {
      // max_length=-1 means MAX, not a missing width.
      descriptor[key] = source === "max_length" && (value === -1 || value === "-1") ? -1 : integer(value);
    }
  }
  if (native && dimensionsPresent) {
    const width = descriptor.maxLength;
    if (
      native.length !== undefined &&
      width !== undefined &&
      (native.length === "max" ? width !== -1 : width !== native.length * (native.name.startsWith("n") ? 2 : 1))
    )
      throw new TypeError("SQL Server native width descriptors disagree");
    if (
      native.name === "decimal" &&
      ((descriptor.precision !== undefined && descriptor.precision !== native.precision) ||
        (descriptor.scale !== undefined && descriptor.scale !== native.scale))
    )
      throw new TypeError("SQL Server native decimal descriptors disagree");
    if (
      ["time", "datetime2", "datetimeoffset"].includes(native.name) &&
      descriptor.scale !== undefined &&
      descriptor.scale !== native.scale
    )
      throw new TypeError("SQL Server native temporal descriptors disagree");
  }
  return {
    nativeType:
      native && dimensionsPresent
        ? known({ name: native.text, complete })
        : unknown("native-system-identity-unavailable"),
    runtimeType:
      runtime === "unknown" || runtime === "never"
        ? unknown("native-runtime-representation-unavailable")
        : known(runtime),
    nullable,
    descriptor,
  };
}

/** Preserve independent native facets; no static analyzer claim or application binding is an input. */
export function sqlServerContractColumns(
  rows: readonly Row[],
  inputPolicy: SqlServerTypePolicy = defaultSqlServerTypePolicy,
): NativeQueryContractEvidence["columns"] {
  rows = snapshot(rows);
  const policy = validateSqlServerTypePolicy(snapshot(inputPolicy));
  if (!Array.isArray(rows) || !rows.length || rows.length > 4096)
    throw new TypeError("SQL Server result descriptions are unavailable");
  const columns: NativeQueryContractEvidence["columns"][number][] = [];
  const names = new Set<string>();
  for (const row of rows) {
    if (row.error_number != null || row.error_type != null)
      throw new TypeError("SQL Server could not describe the result");
    if (flag(row.is_hidden)) continue;
    const ordinal = integer(row.column_ordinal),
      name = text(row.name, 128);
    if (ordinal !== columns.length + 1 || names.has(name))
      throw new TypeError("SQL Server result labels or ordinals are ambiguous");
    names.add(name);
    columns.push({ ...scalar(row, false, policy), name });
  }
  if (!columns.length) throw new TypeError("SQL Server returned no visible result descriptors");
  return Object.freeze(columns);
}

/** Only native inferred system declarations can select the parameterized statement to describe. */
export function sqlServerContractParameters(
  rows: readonly Row[],
  indices: readonly number[],
  inputPolicy: SqlServerTypePolicy = defaultSqlServerTypePolicy,
): {
  readonly parameters: NativeQueryContractEvidence["parameters"];
  readonly declarations: string;
} {
  rows = snapshot(rows);
  indices = snapshot(indices);
  const policy = validateSqlServerTypePolicy(snapshot(inputPolicy));
  if (
    indices.length > 2100 ||
    indices.some((index, position) => index !== position + 1) ||
    rows.length !== indices.length
  )
    throw new TypeError("SQL Server parameter descriptions are unavailable");
  const fields = new Map<number, NativeQueryContractEvidence["parameters"][number]>();
  const declarations = new Map<number, string>();
  const ordinals = new Set<number>();
  for (const row of rows) {
    if (row.error_number != null || row.error_type != null)
      throw new TypeError("SQL Server could not describe parameters");
    const name = text(row.name, 128),
      match = /^@__typed_sql_([1-9]\d*)$/u.exec(name);
    const index = Number(match?.[1]);
    const ordinal = integer(row.parameter_ordinal);
    if (
      !match ||
      !indices.includes(index) ||
      fields.has(index) ||
      ordinal < 1 ||
      ordinal > indices.length ||
      ordinals.has(ordinal)
    )
      throw new TypeError("SQL Server inferred parameter identities differ");
    ordinals.add(ordinal);
    const field = scalar(row, true, policy);
    if (
      field.nativeType.status !== "known" ||
      !field.descriptor.bindingIdentityKnown ||
      field.runtimeType.status !== "known"
    )
      throw new TypeError("SQL Server parameter binding identity is incomplete");
    fields.set(index, { ...field, descriptor: { ...field.descriptor, nativeOrdinal: ordinal, name }, index });
    declarations.set(index, `${name} ${field.nativeType.value.name}`);
  }
  return Object.freeze({
    parameters: Object.freeze(indices.map((index) => fields.get(index)!)),
    declarations: indices.map((index) => declarations.get(index)!).join(", "),
  });
}
