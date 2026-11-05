import {
  type ColumnSnapshotV2,
  type ConstraintSnapshot,
  defineSchemaSnapshotV2,
  type ForeignKeyAction,
  fingerprintSchemaExpression,
  type IndexSnapshot,
  type RelationSnapshot,
  type RoutineSnapshot,
  type SchemaInput,
  type SchemaProvider,
  type SchemaSnapshotV2,
  type TypeSnapshot,
} from "@typed-sql/schema";
import { sqlServerServerEvidence } from "./capabilities.js";
import { parseSqlServerNativeType } from "./native-types.js";
import {
  defaultSqlServerTypePolicy,
  mapSqlServerType,
  type SqlServerTypePolicy,
  validateSqlServerTypePolicy,
} from "./type-policy.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";
export interface SqlServerQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
}
export interface SqlServerSchemaProviderOptions {
  readonly client?: SqlServerQueryable;
  readonly includeSchemas?: readonly string[];
  readonly typePolicy?: SqlServerTypePolicy;
}
/** Queries use only catalog columns present at the SQL Server 2017 floor. Definitions are hashed locally. */
export const sqlServerCatalogQueries = Object.freeze({
  server: `SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion')) AS version,CONVERT(nvarchar(128),SERVERPROPERTY('Edition')) AS edition,CONVERT(int,SERVERPROPERTY('EngineEdition')) AS engine_edition,DB_NAME() AS database_name,SCHEMA_NAME() AS default_schema,d.compatibility_level,d.collation_name,CONVERT(int,SESSIONPROPERTY('QUOTED_IDENTIFIER')) AS quoted_identifier,CONVERT(int,SESSIONPROPERTY('ANSI_WARNINGS')) AS ansi_warnings,CONVERT(int,SESSIONPROPERTY('ARITHABORT')) AS arith_abort,CONVERT(int,SESSIONPROPERTY('CONCAT_NULL_YIELDS_NULL')) AS concat_null_on,@@DATEFIRST AS date_first,@@LANGUAGE AS language,CONVERT(int,HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION')) AS can_view_definition FROM sys.databases d WHERE d.database_id=DB_ID()`,
  options: "DBCC USEROPTIONS WITH NO_INFOMSGS",
  schemas:
    "SELECT name FROM sys.schemas WHERE schema_id<16384 AND name NOT IN ('sys','INFORMATION_SCHEMA') ORDER BY name",
  types: `SELECT s.name AS schema_name,t.name AS type_name,t.user_type_id,t.system_type_id,t.is_user_defined,t.is_assembly_type,t.is_table_type,b.name AS base_name,t.max_length,t.precision,t.scale,t.is_nullable,t.default_object_id,t.rule_object_id,OBJECT_DEFINITION(NULLIF(t.default_object_id,0)) AS bound_default_expression,OBJECT_DEFINITION(NULLIF(t.rule_object_id,0)) AS bound_rule_expression FROM sys.types t JOIN sys.schemas s ON s.schema_id=t.schema_id LEFT JOIN sys.types b ON b.user_type_id=t.system_type_id AND b.user_type_id=b.system_type_id ORDER BY s.name,t.name`,
  relations: `SELECT s.name AS schema_name,o.name AS object_name,o.object_id,o.type AS object_type,t.temporal_type,t.history_table_id,t.is_memory_optimized,t.is_filetable,CONVERT(int,CASE WHEN EXISTS(SELECT 1 FROM sys.triggers tr WHERE tr.parent_id=o.object_id AND tr.is_disabled=0) THEN 1 ELSE 0 END) AS enabled_after_trigger FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.tables t ON t.object_id=o.object_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name`,
  columns: `SELECT c.object_id,c.column_id,c.name AS column_name,c.user_type_id,c.system_type_id,c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,c.is_computed,c.is_hidden,c.generated_always_type,c.is_sparse,c.is_column_set,c.collation_name,CONVERT(int,COLLATIONPROPERTY(c.collation_name,'CodePage')) AS code_page,c.encryption_type,c.is_masked,cc.is_persisted,cc.definition AS generation_expression,c.default_object_id,c.rule_object_id,ut.default_object_id AS type_default_object_id,ut.rule_object_id AS type_rule_object_id,OBJECT_DEFINITION(NULLIF(c.default_object_id,0)) AS default_expression,OBJECT_DEFINITION(NULLIF(c.rule_object_id,0)) AS bound_rule_expression,CONVERT(nvarchar(128),ic.seed_value) AS identity_seed,CONVERT(nvarchar(128),ic.increment_value) AS identity_increment FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.types ut ON ut.user_type_id=c.user_type_id LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id WHERE o.is_ms_shipped=0 AND o.type IN ('U','V','IF','TF','FT') ORDER BY c.object_id,c.column_id`,
  constraints: `SELECT kc.parent_object_id AS object_id,kc.object_id AS constraint_id,kc.name,kc.type AS constraint_type,ic.key_ordinal AS ordinal,c.name AS column_name,CAST(NULL AS nvarchar(128)) AS referenced_schema,CAST(NULL AS nvarchar(128)) AS referenced_table,CAST(NULL AS nvarchar(128)) AS referenced_column,CAST(NULL AS nvarchar(60)) AS delete_action,CAST(NULL AS nvarchar(60)) AS update_action,CAST(NULL AS nvarchar(max)) AS definition,CAST(0 AS bit) AS is_disabled,CAST(0 AS bit) AS is_not_trusted FROM sys.key_constraints kc JOIN sys.index_columns ic ON ic.object_id=kc.parent_object_id AND ic.index_id=kc.unique_index_id AND ic.key_ordinal>0 JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id UNION ALL SELECT fk.parent_object_id,fk.object_id,fk.name,'F',fc.constraint_column_id,c.name,rs.name,ro.name,rc.name,fk.delete_referential_action_desc,fk.update_referential_action_desc,NULL,fk.is_disabled,fk.is_not_trusted FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=fk.object_id JOIN sys.columns c ON c.object_id=fc.parent_object_id AND c.column_id=fc.parent_column_id JOIN sys.objects ro ON ro.object_id=fc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=ro.schema_id JOIN sys.columns rc ON rc.object_id=fc.referenced_object_id AND rc.column_id=fc.referenced_column_id UNION ALL SELECT ch.parent_object_id,ch.object_id,ch.name,'C',0,c.name,NULL,NULL,NULL,NULL,NULL,ch.definition,ch.is_disabled,ch.is_not_trusted FROM sys.check_constraints ch LEFT JOIN sys.columns c ON c.object_id=ch.parent_object_id AND c.column_id=ch.parent_column_id ORDER BY object_id,constraint_id,ordinal`,
  indexes: `SELECT i.object_id,i.index_id,i.name,i.is_unique,i.type_desc,i.is_disabled,i.is_hypothetical,i.has_filter,i.filter_definition,ic.index_column_id,ic.key_ordinal,ic.is_descending_key,ic.is_included_column,c.name AS column_name FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id LEFT JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id LEFT JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE o.is_ms_shipped=0 AND i.index_id>0 ORDER BY i.object_id,i.index_id,ic.index_column_id`,
  routines: `SELECT s.name AS schema_name,o.name AS routine_name,o.object_id,o.type AS object_type,CONVERT(int,OBJECTPROPERTYEX(o.object_id,'IsDeterministic')) AS deterministic,m.is_schema_bound,m.null_on_null_input,m.uses_quoted_identifier,m.uses_ansi_nulls,CONVERT(int,CASE WHEN m.definition IS NULL THEN 1 ELSE 0 END) AS definition_unavailable FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.is_ms_shipped=0 AND o.type IN ('FN','IF','TF','FS','FT','P','PC','AF') ORDER BY s.name,o.name`,
  parameters: `SELECT p.object_id,p.parameter_id,p.name AS parameter_name,p.user_type_id,p.system_type_id,p.max_length,p.precision,p.scale,p.is_output,p.is_readonly,p.has_default_value FROM sys.parameters p JOIN sys.objects o ON o.object_id=p.object_id WHERE o.is_ms_shipped=0 ORDER BY p.object_id,p.parameter_id`,
});
type Row = Record<string, unknown>;
const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length > 1024 * 1024)
    throw new TypeError(`SQL Server catalog ${key} must be bounded text`);
  return value;
};
const integer = (row: Row, key: string): number => {
  const value = row[key];
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) throw new TypeError(`SQL Server catalog ${key} must be a safe integer`);
  return number;
};
const flag = (row: Row, key: string): boolean => {
  const value = row[key];
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new TypeError(`SQL Server catalog ${key} must be Boolean`);
};
const optionalText = (row: Row, key: string): string | undefined =>
  row[key] === null || row[key] === undefined ? undefined : text(row, key);
const identity = (schema: string, name: string) => `${schema}.${name}`;
function nativeType(row: Row, base: string): string {
  let declaration = base.toLowerCase();
  if (["char", "varchar", "binary", "varbinary", "nchar", "nvarchar"].includes(declaration)) {
    const length = integer(row, "max_length");
    declaration += `(${length === -1 ? "max" : ["nchar", "nvarchar"].includes(declaration) ? length / 2 : length})`;
  } else if (["decimal", "numeric"].includes(declaration))
    declaration += `(${integer(row, "precision")},${integer(row, "scale")})`;
  else if (["time", "datetime2", "datetimeoffset"].includes(declaration)) declaration += `(${integer(row, "scale")})`;
  else if (declaration === "float") declaration += `(${integer(row, "precision")})`;
  return parseSqlServerNativeType(declaration)?.text ?? declaration;
}
function rowsBy(rows: readonly Row[], key: string): Map<number, Row[]> {
  const map = new Map<number, Row[]>();
  for (const row of rows) {
    const id = integer(row, key);
    const list = map.get(id) ?? [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}
const action = (value: unknown): ForeignKeyAction =>
  (({ NO_ACTION: "no-action", CASCADE: "cascade", SET_NULL: "set-null", SET_DEFAULT: "set-default" }) as const)[
    String(value) as "NO_ACTION"
  ] ?? "unknown";
export async function readSqlServerServerEvidence(client: SqlServerQueryable) {
  const version = (await client.all(sqlServerCatalogQueries.server))[0];
  if (!version) throw new TypeError("SQL Server introspection returned no server evidence");
  const userOptions = await client.all(sqlServerCatalogQueries.options);
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
export class SqlServerSchemaProvider implements SchemaProvider<SchemaSnapshotV2 & { readonly dialect: "sqlserver" }> {
  readonly #options: SqlServerSchemaProviderOptions;
  constructor(options: SqlServerSchemaProviderOptions = {}) {
    this.#options = options;
    validateSqlServerTypePolicy(options.typePolicy ?? defaultSqlServerTypePolicy);
    if (options.includeSchemas?.some((name) => !name || name.length > 128))
      throw new TypeError("SQL Server includeSchemas requires nonempty bounded identifiers");
  }
  async introspect(_input: SchemaInput = {}): Promise<SchemaSnapshotV2 & { readonly dialect: "sqlserver" }> {
    const client = this.#options.client;
    if (!client)
      throw new TypeError(
        "SQL Server schema provider requires an injected queryable; use @typed-sql/sqlserver/odbc for explicit native loading",
      );
    const policy = this.#options.typePolicy ?? defaultSqlServerTypePolicy;
    const { server, canViewDefinition } = await readSqlServerServerEvidence(client);
    if (!canViewDefinition)
      throw new TypeError("SQL Server complete snapshots require database VIEW DEFINITION permission");
    // One connection is deliberately queried sequentially; native ODBC does not promise MARS.
    const schemaRows = await client.all(sqlServerCatalogQueries.schemas);
    const schemas = this.#options.includeSchemas ?? schemaRows.map((row) => text(row, "name"));
    for (const schema of schemas)
      if (!schemaRows.some((row) => text(row, "name") === schema))
        throw new TypeError(`SQL Server requested schema ${schema} is not visible`);
    const included = new Set(schemas),
      typeRows = await client.all(sqlServerCatalogQueries.types),
      relationRows = await client.all(sqlServerCatalogQueries.relations),
      columnRows = await client.all(sqlServerCatalogQueries.columns),
      constraintRows = await client.all(sqlServerCatalogQueries.constraints),
      indexRows = await client.all(sqlServerCatalogQueries.indexes),
      routineRows = await client.all(sqlServerCatalogQueries.routines),
      parameterRows = await client.all(sqlServerCatalogQueries.parameters);
    const nativeTypes = new Map<number, Row>(),
      types: Record<string, TypeSnapshot> = Object.create(null);
    for (const row of typeRows) nativeTypes.set(integer(row, "user_type_id"), row);
    const resolveType = (row: Row) => {
      const declared = nativeTypes.get(integer(row, "user_type_id"));
      if (!declared) throw new TypeError("SQL Server catalog references an invisible type");
      const schema = text(declared, "schema_name"),
        name = text(declared, "type_name"),
        base = optionalText(declared, "base_name") ?? name;
      const opaque = flag(declared, "is_assembly_type") || flag(declared, "is_table_type");
      return {
        identity: identity(schema, name),
        databaseType: opaque ? identity(schema, name) : nativeType(row, base),
        opaque,
      };
    };
    for (const row of typeRows) {
      const schema = text(row, "schema_name"),
        name = text(row, "type_name"),
        id = identity(schema, name),
        resolved = resolveType(row),
        tsType = resolved.opaque ? policy.unknown : mapSqlServerType(resolved.databaseType, policy);
      types[id] = resolved.opaque
        ? {
            kind: "opaque",
            name,
            schema,
            identity: id,
            databaseType: resolved.databaseType,
            tsType,
            reason: flag(row, "is_table_type")
              ? "Table-valued native transport requires an explicit structured codec"
              : "CLR/UDT native transport requires an explicit qualified codec",
          }
        : {
            kind: "scalar",
            name,
            schema,
            identity: id,
            databaseType: resolved.databaseType,
            tsType,
            extension: {
              version: "1",
              attributes: {
                custom: flag(row, "is_user_defined"),
                systemTypeId: integer(row, "system_type_id"),
                declaredNullable: flag(row, "is_nullable"),
                defaultObjectId: integer(row, "default_object_id"),
                ruleObjectId: integer(row, "rule_object_id"),
                ...(optionalText(row, "bound_default_expression")
                  ? { boundDefaultHash: fingerprintSchemaExpression(text(row, "bound_default_expression")) }
                  : {}),
                ...(optionalText(row, "bound_rule_expression")
                  ? { boundRuleHash: fingerprintSchemaExpression(text(row, "bound_rule_expression")) }
                  : {}),
              },
            },
          };
    }
    const columnsByObject = rowsBy(columnRows, "object_id"),
      constraintsByObject = rowsBy(constraintRows, "object_id"),
      indexesByObject = rowsBy(indexRows, "object_id"),
      parametersByObject = rowsBy(parameterRows, "object_id");
    const columns = (id: number, view: boolean, history = false): Record<string, ColumnSnapshotV2> => {
      const result: Record<string, ColumnSnapshotV2> = Object.create(null);
      for (const [position, row] of (columnsByObject.get(id) ?? []).entries()) {
        const resolved = resolveType(row),
          name = text(row, "column_name"),
          generated = flag(row, "is_computed"),
          identity = flag(row, "is_identity"),
          hidden = flag(row, "is_hidden"),
          always = integer(row, "generated_always_type") !== 0,
          encrypted = row.encryption_type !== null && row.encryption_type !== undefined;
        const expression = optionalText(row, "generation_expression"),
          defaultExpression = optionalText(row, "default_expression"),
          collation = optionalText(row, "collation_name");
        result[name] = {
          name,
          position,
          databaseType: resolved.databaseType,
          typeIdentity: resolved.identity,
          tsType: encrypted ? policy.unknown : mapSqlServerType(resolved.databaseType, policy),
          nullable: flag(row, "is_nullable"),
          nullabilitySource: "declared",
          default:
            defaultExpression || integer(row, "default_object_id") !== 0
              ? "present"
              : integer(row, "type_default_object_id") !== 0
                ? "unknown"
                : "none",
          ...(defaultExpression ? { defaultExpressionHash: fingerprintSchemaExpression(defaultExpression) } : {}),
          generated: generated ? (flag(row, "is_persisted") ? "stored" : "virtual") : "none",
          ...(expression ? { generatedExpressionHash: fingerprintSchemaExpression(expression) } : {}),
          identity: identity ? "always" : "none",
          ...(collation ? { collation } : {}),
          classification: hidden ? "hidden" : "normal",
          insertable: view
            ? "unknown"
            : !history && !generated && !identity && !always && resolved.databaseType !== "rowversion" && !encrypted,
          updatable: view
            ? "unknown"
            : !history && !generated && !identity && !always && resolved.databaseType !== "rowversion" && !encrypted,
          extension: {
            version: "1",
            attributes: {
              columnId: integer(row, "column_id"),
              defaultObjectId: integer(row, "default_object_id"),
              ruleObjectId: integer(row, "rule_object_id"),
              typeDefaultObjectId: integer(row, "type_default_object_id"),
              typeRuleObjectId: integer(row, "type_rule_object_id"),
              ...(optionalText(row, "bound_rule_expression")
                ? { boundRuleHash: fingerprintSchemaExpression(text(row, "bound_rule_expression")) }
                : {}),
              sparse: flag(row, "is_sparse"),
              columnSet: flag(row, "is_column_set"),
              masked: flag(row, "is_masked"),
              encrypted,
              generatedAlwaysType: integer(row, "generated_always_type"),
              ...(collation && row.code_page !== null ? { codePage: integer(row, "code_page") } : {}),
              ...(identity
                ? {
                    seed: optionalText(row, "identity_seed") ?? "unknown",
                    increment: optionalText(row, "identity_increment") ?? "unknown",
                  }
                : {}),
            },
          },
        };
      }
      return result;
    };
    const constraints = (id: number): ConstraintSnapshot[] => {
      const result: ConstraintSnapshot[] = [];
      for (const group of rowsBy(constraintsByObject.get(id) ?? [], "constraint_id").values()) {
        const row = group[0]!,
          kind = text(row, "constraint_type"),
          base = {
            name: text(row, "name"),
            identity: `${id}:${integer(row, "constraint_id")}`,
            columns: group.map((row) => optionalText(row, "column_name")).filter((v): v is string => v !== undefined),
            partial: false,
            expressionBased: kind === "C",
            deferrable: false,
            initiallyDeferred: false,
            extension: {
              version: "1",
              attributes: { enabled: !flag(row, "is_disabled"), trusted: !flag(row, "is_not_trusted") },
            },
          };
        if (kind === "PK") result.push({ ...base, kind: "primary-key", nullsDistinct: false });
        else if (kind === "UQ") result.push({ ...base, kind: "unique", nullsDistinct: false });
        else if (kind === "F")
          result.push({
            ...base,
            kind: "foreign-key",
            referencedRelation: identity(text(row, "referenced_schema"), text(row, "referenced_table")),
            referencedColumns: group.map((row) => text(row, "referenced_column")),
            match: "simple",
            onUpdate: action(row.update_action),
            onDelete: action(row.delete_action),
          });
        else if (kind === "C") {
          const expression = optionalText(row, "definition");
          result.push({
            ...base,
            kind: "check",
            predicate: expression ? "present" : "unknown",
            ...(expression ? { predicateHash: fingerprintSchemaExpression(expression) } : {}),
          });
        } else throw new TypeError("Unmodeled SQL Server constraint kind");
      }
      return result;
    };
    const indexes = (id: number): IndexSnapshot[] =>
      [...rowsBy(indexesByObject.get(id) ?? [], "index_id").values()].map((group) => {
        const row = group[0]!,
          filter = optionalText(row, "filter_definition");
        return {
          name: text(row, "name"),
          identity: `${id}:${integer(row, "index_id")}`,
          unique: flag(row, "is_unique"),
          method: text(row, "type_desc"),
          columns: group
            .filter((row) => !flag(row, "is_included_column") && integer(row, "key_ordinal") > 0)
            .map((row) => ({ column: text(row, "column_name"), descending: flag(row, "is_descending_key") })),
          includedColumns: group
            .filter((row) => flag(row, "is_included_column"))
            .map((row) => text(row, "column_name")),
          predicate: flag(row, "has_filter") ? (filter ? "present" : "unknown") : "none",
          ...(filter ? { predicateHash: fingerprintSchemaExpression(filter) } : {}),
          valid: !flag(row, "is_disabled") && !flag(row, "is_hypothetical"),
        };
      });
    const relations: Record<string, RelationSnapshot> = Object.create(null);
    for (const row of relationRows) {
      const schema = text(row, "schema_name");
      if (!included.has(schema)) continue;
      const name = text(row, "object_name"),
        id = integer(row, "object_id"),
        view = text(row, "object_type").trim() === "V";
      relations[identity(schema, name)] = {
        name,
        schema,
        kind: view ? "view" : "table",
        columns: columns(id, view, row.temporal_type !== null && integer(row, "temporal_type") === 1),
        constraints: constraints(id),
        indexes: indexes(id),
        capabilities: {
          outputWithoutInto: !flag(row, "enabled_after_trigger"),
          insertable: view ? "unknown" : integer(row, "temporal_type") !== 1,
          updatable: view ? "unknown" : integer(row, "temporal_type") !== 1,
          deletable: view ? "unknown" : integer(row, "temporal_type") !== 1,
        },
        extension: {
          version: "1",
          attributes: {
            objectId: id,
            temporalType: row.temporal_type === null ? 0 : integer(row, "temporal_type"),
            historyTableId: row.history_table_id === null ? 0 : integer(row, "history_table_id"),
            memoryOptimized: row.is_memory_optimized === null ? false : flag(row, "is_memory_optimized"),
            fileTable: row.is_filetable === null ? false : flag(row, "is_filetable"),
          },
        },
      };
    }
    const routines: Record<string, RoutineSnapshot[]> = Object.create(null);
    for (const row of routineRows) {
      const schema = text(row, "schema_name");
      if (!included.has(schema)) continue;
      const name = text(row, "routine_name"),
        id = integer(row, "object_id"),
        kind = text(row, "object_type").trim(),
        parameters = parametersByObject.get(id) ?? [],
        returned = parameters.find((row) => integer(row, "parameter_id") === 0),
        table = ["IF", "TF", "FT"].includes(kind),
        command = ["P", "PC"].includes(kind),
        returnType = returned ? resolveType(returned) : undefined;
      const routine: RoutineSnapshot = {
        name,
        schema,
        identity: `${schema}.${name}:${id}`,
        kind: command ? "procedure" : kind === "AF" ? "aggregate" : "function",
        arguments: parameters
          .filter((row) => integer(row, "parameter_id") > 0)
          .map((row) => {
            const resolved = resolveType(row);
            return {
              name: text(row, "parameter_name").replace(/^@/u, ""),
              mode: flag(row, "is_output") ? "inout" : "in",
              typeIdentity: resolved.identity,
              databaseType: resolved.databaseType,
              tsType: mapSqlServerType(resolved.databaseType, policy),
              default: flag(row, "has_default_value") ? "present" : "unknown",
            };
          }),
        result: command
          ? { kind: "command" }
          : table
            ? { kind: "table", columns: columns(id, true) }
            : returnType
              ? {
                  kind: "scalar",
                  typeIdentity: returnType.identity,
                  databaseType: returnType.databaseType,
                  tsType: mapSqlServerType(returnType.databaseType, policy),
                  nullable: true,
                }
              : {
                  kind: "scalar",
                  typeIdentity: "sys.sql_variant",
                  databaseType: "sql_variant",
                  tsType: policy.unknown,
                  nullable: true,
                },
        volatility: "unknown",
        deterministic: row.deterministic === null ? "unknown" : flag(row, "deterministic"),
        dataAccess: "unknown",
        nullInput: row.null_on_null_input === null ? "unknown" : flag(row, "null_on_null_input") ? "strict" : "called",
        extension: {
          version: "1",
          attributes: {
            objectId: id,
            schemaBound: row.is_schema_bound === null ? false : flag(row, "is_schema_bound"),
            definitionUnavailable: flag(row, "definition_unavailable"),
          },
        },
      };
      const key = identity(schema, name);
      routines[key] ??= [];
      routines[key].push(routine);
    }
    return defineSchemaSnapshotV2({
      formatVersion: 2,
      dialect: "sqlserver",
      dialectVersion: SQLSERVER_DIALECT_VERSION,
      server,
      namespaces: Object.fromEntries(schemas.map((name) => [name, { name, kind: "schema" as const }])),
      types,
      relations,
      routines,
      extension: {
        version: "1",
        attributes: { catalogVisibility: "database-view-definition", includedSchemas: [...schemas] },
      },
    }) as SchemaSnapshotV2 & { readonly dialect: "sqlserver" };
  }
}
export async function introspectSqlServer(options: SqlServerSchemaProviderOptions): Promise<SchemaSnapshotV2> {
  return new SqlServerSchemaProvider(options).introspect({});
}
