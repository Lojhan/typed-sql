import { sqlServerServerEvidence } from "./capabilities.js";
import type { SqlServerQueryable } from "./provider-contracts.js";

type Row = Readonly<Record<string, unknown>>;

export const sqlServerServerQueries = Object.freeze({
  server: `SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion')) AS version,CONVERT(nvarchar(128),SERVERPROPERTY('Edition')) AS edition,CONVERT(int,SERVERPROPERTY('EngineEdition')) AS engine_edition,DB_NAME() AS database_name,SCHEMA_NAME() AS default_schema,d.compatibility_level,d.collation_name,CONVERT(int,SESSIONPROPERTY('QUOTED_IDENTIFIER')) AS quoted_identifier,CONVERT(int,SESSIONPROPERTY('ANSI_WARNINGS')) AS ansi_warnings,CONVERT(int,SESSIONPROPERTY('ARITHABORT')) AS arith_abort,CONVERT(int,SESSIONPROPERTY('CONCAT_NULL_YIELDS_NULL')) AS concat_null_on,@@DATEFIRST AS date_first,@@LANGUAGE AS language,CONVERT(int,HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION')) AS can_view_definition FROM sys.databases d WHERE d.database_id=DB_ID()`,
  options: "DBCC USEROPTIONS WITH NO_INFOMSGS",
});
export const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length > 1024 * 1024)
    throw new TypeError(`SQL Server catalog ${key} must be bounded text`);
  return value;
};
export const integer = (row: Row, key: string): number => {
  const value = row[key];
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) throw new TypeError(`SQL Server catalog ${key} must be a safe integer`);
  return number;
};
export const flag = (row: Row, key: string): boolean => {
  const value = row[key];
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new TypeError(`SQL Server catalog ${key} must be Boolean`);
};
export async function readSqlServerServerEvidence(client: SqlServerQueryable) {
  const version = (await client.all(sqlServerServerQueries.server))[0];
  if (!version) throw new TypeError("SQL Server introspection returned no server evidence");
  const userOptions = await client.all(sqlServerServerQueries.options);
  const option = (name: string) => {
    const row = userOptions.find(
      (row) => String(row.SetOption ?? row.set_option ?? row["Set Option"]).toLowerCase() === name,
    );
    if (!row) throw new TypeError(`SQL Server session option ${name} is unavailable`);
    return String(row.Value ?? row.value);
  };
  const server = sqlServerServerEvidence(text(version, "version"), {
    compatibilityLevel: integer(version, "compatibility_level"),
    collation: text(version, "collation_name"),
    defaultSchema: text(version, "default_schema"),
    quotedIdentifier: flag(version, "quoted_identifier"),
    ansiWarnings: flag(version, "ansi_warnings"),
    arithAbort: flag(version, "arith_abort"),
    concatNullYieldsNull: flag(version, "concat_null_on"),
    dateFirst: integer(version, "date_first"),
    dateFormat: option("dateformat"),
    language: text(version, "language"),
    databaseName: text(version, "database_name"),
    edition: text(version, "edition"),
    engineEdition: integer(version, "engine_edition"),
  });
  return { server, canViewDefinition: flag(version, "can_view_definition") };
}
