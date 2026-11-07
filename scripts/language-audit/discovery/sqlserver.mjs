import { sqlServerMapper } from "../../../tools/grammar-catalog/src/mappers/sqlserver.mjs";
import { legacyDiscoveryDefaults } from "./shared.mjs";

export const sqlserverDiscovery = {
  ...sqlServerMapper,
  ...legacyDiscoveryDefaults,
  discoveryQueries: () => ({
    functions: `SELECT o.name, SCHEMA_NAME(o.schema_id) AS namespace, o.type AS kind,
      (SELECT COUNT(*) FROM sys.parameters p WHERE p.object_id=o.object_id AND p.parameter_id>0) AS arity,
      OBJECTPROPERTY(o.object_id,'IsDeterministic') AS deterministic,
      (SELECT p.parameter_id AS position, p.name, t.name AS type_name, SCHEMA_NAME(t.schema_id) AS type_schema,
        p.max_length, p.precision, p.scale, p.is_output, p.is_nullable, p.is_readonly, p.has_default_value,
        CONVERT(nvarchar(128),SQL_VARIANT_PROPERTY(p.default_value,'BaseType')) AS default_value_type,
        CONVERT(varchar(max),CONVERT(varbinary(max),p.default_value),2) AS default_value_binary_hex
        FROM sys.parameters p LEFT JOIN sys.types t ON t.user_type_id=p.user_type_id WHERE p.object_id=o.object_id
        ORDER BY p.parameter_id FOR JSON PATH, INCLUDE_NULL_VALUES) AS parameters_json,
      (SELECT c.column_id AS position, c.name, t.name AS type_name, SCHEMA_NAME(t.schema_id) AS type_schema,
        c.max_length, c.precision, c.scale, c.is_nullable FROM sys.columns c LEFT JOIN sys.types t ON t.user_type_id=c.user_type_id
        WHERE c.object_id=o.object_id ORDER BY c.column_id FOR JSON PATH, INCLUDE_NULL_VALUES) AS return_columns_json
      FROM sys.system_objects o WHERE o.type IN ('FN','IF','TF','FS','FT','AF')`,
    types: "SELECT name, system_type_id, max_length, precision, scale FROM sys.types WHERE is_user_defined=0",
    collations: "SELECT name FROM sys.fn_helpcollations()",
    settings:
      "SELECT name, CONVERT(bigint,minimum) AS minimum, CONVERT(bigint,maximum) AS maximum, is_dynamic, is_advanced FROM sys.configurations",
  }),
  discoveryScope: (category) => (category === "functions" ? "system-objects-only" : "engine"),
};
