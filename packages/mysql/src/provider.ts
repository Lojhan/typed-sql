import {
  defineSchemaSnapshotV2,
  type ForeignKeyAction,
  fingerprintSchemaExpression,
  type RelationSnapshot,
  type RoutineSnapshot,
  type SchemaInput,
  type SchemaProvider,
  type SchemaSnapshot,
  type SchemaSnapshotV2,
  type TypeSnapshot,
} from "@typed-sql/schema";
import { mySqlServerEvidence } from "./capabilities.js";
import { mySqlCoreCatalogForSchema } from "./catalog/index.js";
import {
  defaultMySqlTypePolicy,
  type MySqlTypePolicy,
  mapMySqlType,
  mySqlEnumValues,
  mySqlSetValues,
} from "./type-policy.js";
import { MYSQL_DIALECT_VERSION } from "./version.js";

export interface MySqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
}

export interface MySqlQueryable {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<MySqlQueryResult<Row>>;
}

export interface MySqlSchemaProviderOptions {
  readonly client?: MySqlQueryable;
  readonly includeSchemas?: readonly string[];
  readonly typePolicy?: MySqlTypePolicy;
}

export type MySqlIntrospectionCatalog = "schemas" | "columns" | "routines" | "parameters" | "constraints" | "indexes";

export interface MySqlIntrospectionDiagnostic {
  readonly code: "TSQ406";
  readonly severity: "warning";
  readonly catalog: MySqlIntrospectionCatalog;
  readonly message: string;
}

export interface MySqlIntrospectionResult {
  readonly snapshot: SchemaSnapshotV2;
  readonly diagnostics: readonly MySqlIntrospectionDiagnostic[];
}

interface VersionRow extends Record<string, unknown> {
  readonly server_version: string;
  readonly sql_mode?: string;
  readonly version_comment?: string;
  readonly character_set_server?: string;
  readonly collation_server?: string;
  readonly character_set_connection?: string;
  readonly collation_connection?: string;
  readonly time_zone?: string;
  readonly system_time_zone?: string;
  readonly lower_case_table_names?: number | string;
}
interface DatabaseRow extends Record<string, unknown> {
  readonly database_name: string | null;
}
interface SchemaRow extends Record<string, unknown> {
  readonly catalog_name: string;
  readonly schema_name: string;
  readonly default_character_set_name: string;
  readonly default_collation_name: string;
}
interface ColumnRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly database_type: string;
  readonly is_nullable: "YES" | "NO";
  readonly default_expression: string | null;
  readonly ordinal_position?: number;
  readonly character_set_name?: string | null;
  readonly collation_name?: string | null;
  readonly extra?: string;
  readonly generation_expression?: string | null;
  readonly table_type?: "BASE TABLE" | "VIEW" | "SYSTEM VIEW";
  readonly view_updatable?: "YES" | "NO" | null;
  readonly character_maximum_length?: number | string | null;
  readonly numeric_precision?: number | string | null;
  readonly numeric_scale?: number | string | null;
  readonly datetime_precision?: number | string | null;
  readonly spatial_reference_system_id?: number | string | null;
}
interface RoutineRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly function_name: string;
  readonly database_return_type: string;
  readonly is_deterministic: "YES" | "NO";
  readonly sql_data_access: "CONTAINS SQL" | "NO SQL" | "READS SQL DATA" | "MODIFIES SQL DATA";
  readonly routine_type?: "FUNCTION" | "PROCEDURE";
  readonly return_character_set?: string | null;
  readonly return_collation?: string | null;
  readonly security_type?: "DEFINER" | "INVOKER";
  readonly creation_sql_mode?: string;
  readonly creation_character_set?: string | null;
  readonly creation_collation?: string | null;
  readonly database_collation?: string | null;
}
interface ParameterRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly routine_name: string;
  readonly ordinal_position: number;
  readonly parameter_mode: "IN" | "OUT" | "INOUT" | null;
  readonly parameter_name: string | null;
  readonly database_type: string;
  readonly character_set_name?: string | null;
  readonly collation_name?: string | null;
}
interface ConstraintRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly constraint_name: string;
  readonly constraint_type: "PRIMARY KEY" | "UNIQUE" | "FOREIGN KEY" | "CHECK";
  readonly columns?: unknown;
  readonly column_name?: string | null;
  readonly referenced_schema?: string | null;
  readonly referenced_table?: string | null;
  readonly referenced_columns?: unknown;
  readonly referenced_column_name?: string | null;
  readonly update_rule?: string | null;
  readonly delete_rule?: string | null;
  readonly check_clause?: string | null;
  readonly ordinal_position?: number;
  readonly enforced?: "YES" | "NO";
}
interface IndexRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly index_name: string;
  readonly is_unique: unknown;
  readonly index_type: string;
  readonly columns?: unknown;
  readonly column_name?: string | null;
  readonly expressions?: unknown;
  readonly expression?: string | null;
  readonly descending?: unknown;
  readonly column_collations?: unknown;
  readonly column_collation?: string | null;
  readonly prefix_lengths?: unknown;
  readonly prefix_length?: number | string | null;
  readonly visible: unknown;
  readonly ordinal_position?: number;
}

interface NormalizedConstraintRow extends ConstraintRow {
  readonly columns: readonly unknown[];
  readonly referenced_schema: string | null;
  readonly referenced_table: string | null;
  readonly referenced_columns: readonly unknown[];
  readonly update_rule: string | null;
  readonly delete_rule: string | null;
  readonly check_clause: string | null;
}

interface NormalizedIndexRow extends IndexRow {
  readonly columns: readonly unknown[];
  readonly expressions: readonly unknown[];
  readonly descending: readonly unknown[];
  readonly column_collations: readonly unknown[];
  readonly prefix_lengths: readonly unknown[];
}

export const mysqlCatalogQueries = Object.freeze({
  version:
    "SELECT VERSION() AS server_version, @@version_comment AS version_comment, @@session.sql_mode AS sql_mode, @@global.character_set_server AS character_set_server, @@global.collation_server AS collation_server, @@session.character_set_connection AS character_set_connection, @@session.collation_connection AS collation_connection, @@session.time_zone AS time_zone, @@global.system_time_zone AS system_time_zone, @@global.lower_case_table_names AS lower_case_table_names",
  database: "SELECT DATABASE() AS database_name",
  schemas(schemaCount: number): string {
    return `
      SELECT 'def' AS catalog_name,
             SCHEMA_NAME AS schema_name,
             DEFAULT_CHARACTER_SET_NAME AS default_character_set_name,
             DEFAULT_COLLATION_NAME AS default_collation_name
      FROM information_schema.SCHEMATA
      WHERE SCHEMA_NAME IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY SCHEMA_NAME
    `;
  },
  columns(schemaCount: number): string {
    return `
      SELECT TABLE_SCHEMA AS schema_name,
             TABLE_NAME AS table_name,
             COLUMN_NAME AS column_name,
             COLUMN_TYPE AS database_type,
             IS_NULLABLE AS is_nullable,
             COLUMN_DEFAULT AS default_expression,
             ORDINAL_POSITION AS ordinal_position,
             CHARACTER_SET_NAME AS character_set_name,
             COLLATION_NAME AS collation_name,
             EXTRA AS extra,
             GENERATION_EXPRESSION AS generation_expression,
             CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
             NUMERIC_PRECISION AS numeric_precision,
             NUMERIC_SCALE AS numeric_scale,
             DATETIME_PRECISION AS datetime_precision,
             SRS_ID AS spatial_reference_system_id,
             t.TABLE_TYPE AS table_type,
             v.IS_UPDATABLE AS view_updatable
      FROM information_schema.COLUMNS
      JOIN information_schema.TABLES AS t USING (TABLE_SCHEMA, TABLE_NAME)
      LEFT JOIN information_schema.VIEWS AS v USING (TABLE_SCHEMA, TABLE_NAME)
      WHERE TABLE_SCHEMA IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    `;
  },
  routines(schemaCount: number): string {
    return `
      SELECT ROUTINE_SCHEMA AS schema_name,
             ROUTINE_NAME AS function_name,
             ROUTINE_TYPE AS routine_type,
             DTD_IDENTIFIER AS database_return_type,
             IS_DETERMINISTIC AS is_deterministic,
             SQL_DATA_ACCESS AS sql_data_access,
             CHARACTER_SET_NAME AS return_character_set,
             COLLATION_NAME AS return_collation,
             SECURITY_TYPE AS security_type,
             SQL_MODE AS creation_sql_mode,
             CHARACTER_SET_CLIENT AS creation_character_set,
             COLLATION_CONNECTION AS creation_collation,
             DATABASE_COLLATION AS database_collation
      FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME
    `;
  },
  parameters(schemaCount: number): string {
    return `
      SELECT SPECIFIC_SCHEMA AS schema_name, SPECIFIC_NAME AS routine_name,
             ORDINAL_POSITION AS ordinal_position, PARAMETER_MODE AS parameter_mode,
             PARAMETER_NAME AS parameter_name, DTD_IDENTIFIER AS database_type,
             CHARACTER_SET_NAME AS character_set_name, COLLATION_NAME AS collation_name
      FROM information_schema.PARAMETERS
      WHERE SPECIFIC_SCHEMA IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION
    `;
  },
  constraints(schemaCount: number): string {
    return `
      SELECT tc.CONSTRAINT_SCHEMA AS schema_name, tc.TABLE_NAME AS table_name,
             tc.CONSTRAINT_NAME AS constraint_name, tc.CONSTRAINT_TYPE AS constraint_type,
             kcu.COLUMN_NAME AS column_name,
             kcu.REFERENCED_TABLE_SCHEMA AS referenced_schema,
             kcu.REFERENCED_TABLE_NAME AS referenced_table,
             kcu.REFERENCED_COLUMN_NAME AS referenced_column_name,
             rc.UPDATE_RULE AS update_rule, rc.DELETE_RULE AS delete_rule,
             cc.CHECK_CLAUSE AS check_clause,
             tc.ENFORCED AS enforced,
             COALESCE(kcu.ORDINAL_POSITION, 0) AS ordinal_position
      FROM information_schema.TABLE_CONSTRAINTS AS tc
      LEFT JOIN information_schema.KEY_COLUMN_USAGE AS kcu
        ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.TABLE_NAME = tc.TABLE_NAME
       AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
        ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      LEFT JOIN information_schema.CHECK_CONSTRAINTS AS cc
        ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY tc.CONSTRAINT_SCHEMA, tc.TABLE_NAME, tc.CONSTRAINT_NAME, ordinal_position
    `;
  },
  indexes(schemaCount: number): string {
    return `
      SELECT s.TABLE_SCHEMA AS schema_name, s.TABLE_NAME AS table_name, s.INDEX_NAME AS index_name,
             (s.NON_UNIQUE = 0) AS is_unique, s.INDEX_TYPE AS index_type,
             s.COLUMN_NAME AS column_name, s.EXPRESSION AS expression,
             COALESCE(s.COLLATION = 'D', 0) AS descending,
             c.COLLATION_NAME AS column_collation,
             s.SUB_PART AS prefix_length,
             (s.IS_VISIBLE = 'YES') AS visible,
             s.SEQ_IN_INDEX AS ordinal_position
      FROM information_schema.STATISTICS AS s
      LEFT JOIN information_schema.COLUMNS AS c
        ON c.TABLE_SCHEMA = s.TABLE_SCHEMA AND c.TABLE_NAME = s.TABLE_NAME
       AND c.COLUMN_NAME = s.COLUMN_NAME
      WHERE s.TABLE_SCHEMA IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX
    `;
  },
});

function relationKey(schemas: readonly string[], schema: string, name: string): string {
  return schemas.length === 1 ? name : `${schema}.${name}`;
}

function foreignKeyAction(value: string | null): ForeignKeyAction {
  const normalized = value?.toUpperCase();
  if (normalized === "RESTRICT") return "restrict";
  if (normalized === "CASCADE") return "cascade";
  if (normalized === "SET NULL") return "set-null";
  if (normalized === "SET DEFAULT") return "set-default";
  if (normalized === "NO ACTION") return "no-action";
  return "unknown";
}

function catalogArray(value: unknown, path: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // The stable, redacted error below is more useful than a driver JSON failure.
    }
  }
  throw new TypeError(`MySQL introspection ${path} must be a JSON array`);
}

function catalogBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  throw new TypeError(`MySQL introspection ${path} must be boolean evidence`);
}

function optionalCatalogInteger(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new TypeError(`MySQL introspection ${path} must be non-negative integer evidence`);
  }
  return normalized as number;
}

function normalizeCatalogSqlMode(value: string): string {
  return [
    ...new Set(
      value
        .split(",")
        .map((mode) => mode.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(",");
}

function normalizeSchemas(values: readonly string[]): readonly string[] {
  const schemas = values.map((value) => {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
      throw new TypeError("MySQL introspection schema names must be non-empty strings without NUL bytes");
    }
    return value.trim();
  });
  return [...new Set(schemas)].sort();
}

function incompleteCatalogDiagnostic(catalog: MySqlIntrospectionCatalog): MySqlIntrospectionDiagnostic {
  return Object.freeze({
    code: "TSQ406",
    severity: "warning",
    catalog,
    message: `MySQL introspection could not read ${catalog} metadata; the snapshot contains incomplete evidence.`,
  });
}

function compareCatalogIdentity(
  left: Pick<ConstraintRow, "schema_name" | "table_name" | "constraint_name">,
  right: Pick<ConstraintRow, "schema_name" | "table_name" | "constraint_name">,
): number {
  return (
    left.schema_name.localeCompare(right.schema_name) ||
    left.table_name.localeCompare(right.table_name) ||
    left.constraint_name.localeCompare(right.constraint_name)
  );
}

function normalizeConstraintRows(rows: readonly ConstraintRow[]): readonly NormalizedConstraintRow[] {
  const groups = new Map<string, ConstraintRow[]>();
  for (const row of rows) {
    const key = `${row.schema_name}\u0000${row.table_name}\u0000${row.constraint_name}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return [...groups.values()]
    .map((group): NormalizedConstraintRow => {
      const ordered = [...group].sort((left, right) => (left.ordinal_position ?? 0) - (right.ordinal_position ?? 0));
      const first = ordered[0]!;
      const referencedRow = ordered.find(
        (row) => row.referenced_schema != null || row.referenced_table != null || row.referenced_column_name != null,
      );
      return {
        ...first,
        referenced_schema: first.referenced_schema ?? referencedRow?.referenced_schema ?? null,
        referenced_table: first.referenced_table ?? referencedRow?.referenced_table ?? null,
        update_rule: first.update_rule ?? null,
        delete_rule: first.delete_rule ?? null,
        check_clause: first.check_clause ?? null,
        columns:
          first.columns === undefined
            ? ordered.map(({ column_name }) => column_name).filter((column) => column != null)
            : catalogArray(first.columns, "constraint columns"),
        referenced_columns:
          first.referenced_columns === undefined
            ? ordered.map(({ referenced_column_name }) => referenced_column_name).filter((column) => column != null)
            : first.referenced_columns === null
              ? []
              : catalogArray(first.referenced_columns, "referenced constraint columns"),
      };
    })
    .sort(compareCatalogIdentity);
}

function normalizeIndexRows(rows: readonly IndexRow[]): readonly NormalizedIndexRow[] {
  const groups = new Map<string, IndexRow[]>();
  for (const row of rows) {
    const key = `${row.schema_name}\u0000${row.table_name}\u0000${row.index_name}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return [...groups.values()]
    .map((group): NormalizedIndexRow => {
      const ordered = [...group].sort((left, right) => (left.ordinal_position ?? 0) - (right.ordinal_position ?? 0));
      const first = ordered[0]!;
      return {
        ...first,
        columns:
          first.columns === undefined
            ? ordered.map(({ column_name }) => column_name ?? null)
            : catalogArray(first.columns, "index columns"),
        expressions:
          first.expressions === undefined
            ? ordered.map(({ expression }) => expression ?? null)
            : catalogArray(first.expressions, "index expressions"),
        descending:
          first.descending === undefined || Array.isArray(first.descending)
            ? first.descending === undefined
              ? ordered.map(() => false)
              : first.descending
            : typeof first.descending === "string" && first.descending.startsWith("[")
              ? catalogArray(first.descending, "index ordering")
              : ordered.map(({ descending }) => descending ?? false),
        column_collations:
          first.column_collations === undefined
            ? ordered.map(({ column_collation }) => column_collation ?? null)
            : catalogArray(first.column_collations, "index column collations"),
        prefix_lengths:
          first.prefix_lengths === undefined
            ? ordered.map(({ prefix_length }) => prefix_length ?? null)
            : catalogArray(first.prefix_lengths, "index prefix lengths"),
      };
    })
    .sort(
      (left, right) =>
        left.schema_name.localeCompare(right.schema_name) ||
        left.table_name.localeCompare(right.table_name) ||
        left.index_name.localeCompare(right.index_name),
    );
}

function routineDataAccess(value: RoutineRow["sql_data_access"]): RoutineSnapshot["dataAccess"] {
  if (value === "NO SQL") return "none";
  if (value === "CONTAINS SQL") return "contains-sql";
  if (value === "READS SQL DATA") return "reads-sql";
  return "modifies-sql";
}

function routineVolatility(row: RoutineRow): RoutineSnapshot["volatility"] {
  if (row.sql_data_access === "MODIFIES SQL DATA" || row.is_deterministic === "NO") return "volatile";
  if (row.sql_data_access === "READS SQL DATA") return "stable";
  return "immutable";
}

export class MySqlSchemaProvider implements SchemaProvider<SchemaSnapshotV2> {
  readonly #client: MySqlQueryable | undefined;
  readonly #schemas: readonly string[] | undefined;
  readonly #policy: MySqlTypePolicy;

  constructor(options: MySqlSchemaProviderOptions = {}) {
    this.#client = options.client;
    this.#schemas = options.includeSchemas;
    this.#policy = options.typePolicy ?? defaultMySqlTypePolicy;
  }

  async introspect(input: SchemaInput): Promise<SchemaSnapshotV2> {
    return (await this.introspectWithDiagnostics(input)).snapshot;
  }

  async introspectWithDiagnostics(_input: SchemaInput): Promise<MySqlIntrospectionResult> {
    const client = this.#client;
    if (client === undefined)
      throw new TypeError(
        "MySQL schema provider requires an injected client; use @typed-sql/mysql/mysql2 for a connection URI",
      );
    const versionRow = (await client.query<VersionRow>(mysqlCatalogQueries.version)).rows[0];
    if (versionRow === undefined) throw new TypeError("MySQL introspection did not return a server version");
    const version = versionRow.server_version;
    const server = mySqlServerEvidence(version, {
      ...(versionRow.sql_mode === undefined ? {} : { sqlMode: versionRow.sql_mode }),
      ...(versionRow.version_comment === undefined ? {} : { versionComment: versionRow.version_comment }),
      ...(versionRow.character_set_server === undefined ? {} : { characterSetServer: versionRow.character_set_server }),
      ...(versionRow.collation_server === undefined ? {} : { collationServer: versionRow.collation_server }),
      ...(versionRow.character_set_connection === undefined
        ? {}
        : { characterSetConnection: versionRow.character_set_connection }),
      ...(versionRow.collation_connection === undefined
        ? {}
        : { collationConnection: versionRow.collation_connection }),
      ...(versionRow.time_zone === undefined ? {} : { timeZone: versionRow.time_zone }),
      ...(versionRow.system_time_zone === undefined ? {} : { systemTimeZone: versionRow.system_time_zone }),
      ...(versionRow.lower_case_table_names === undefined
        ? {}
        : { lowerCaseTableNames: versionRow.lower_case_table_names }),
    });
    if (server.product !== "mysql") {
      throw new TypeError(`MySQL introspection requires an Oracle MySQL server; detected ${server.product}`);
    }
    const typeContext = {
      formatVersion: 1,
      dialect: "mysql",
      tables: {},
      server,
    } as const satisfies SchemaSnapshot;
    const mapType = (databaseType: string): string => mapMySqlType(databaseType, this.#policy, typeContext);
    const currentDatabase = (await client.query<DatabaseRow>(mysqlCatalogQueries.database)).rows[0]?.database_name;
    const schemas = normalizeSchemas(
      this.#schemas ?? (currentDatabase === null || currentDatabase === undefined ? [] : [currentDatabase]),
    );
    if (schemas.length === 0) throw new TypeError("MySQL introspection requires at least one database schema");
    const diagnostics: MySqlIntrospectionDiagnostic[] = [];
    const catalogEvidence = new Map<MySqlIntrospectionCatalog, "complete" | "incomplete">();
    const queryCatalog = async <Row extends Record<string, unknown>>(
      catalog: MySqlIntrospectionCatalog,
      sql: string,
    ): Promise<readonly Row[]> => {
      try {
        const { rows } = await client.query<Row>(sql, schemas);
        catalogEvidence.set(catalog, "complete");
        return rows;
      } catch {
        catalogEvidence.set(catalog, "incomplete");
        diagnostics.push(incompleteCatalogDiagnostic(catalog));
        return [];
      }
    };
    const [schemaRows, columnRows, routineRows, parameterRows, constraintRows, indexRows] = await Promise.all([
      queryCatalog<SchemaRow>("schemas", mysqlCatalogQueries.schemas(schemas.length)),
      queryCatalog<ColumnRow>("columns", mysqlCatalogQueries.columns(schemas.length)),
      queryCatalog<RoutineRow>("routines", mysqlCatalogQueries.routines(schemas.length)),
      queryCatalog<ParameterRow>("parameters", mysqlCatalogQueries.parameters(schemas.length)),
      queryCatalog<ConstraintRow>("constraints", mysqlCatalogQueries.constraints(schemas.length)),
      queryCatalog<IndexRow>("indexes", mysqlCatalogQueries.indexes(schemas.length)),
    ]);
    if (catalogEvidence.get("schemas") === "complete") {
      const visibleSchemas = new Set(schemaRows.map(({ schema_name }) => schema_name));
      if (schemas.some((schema) => !visibleSchemas.has(schema))) {
        catalogEvidence.set("schemas", "incomplete");
        diagnostics.push(incompleteCatalogDiagnostic("schemas"));
      }
    }
    const relations: Record<string, RelationSnapshot> = {};
    const types: Record<string, TypeSnapshot> = {};
    const orderedColumnRows = [...columnRows].sort(
      (left, right) =>
        left.schema_name.localeCompare(right.schema_name) ||
        left.table_name.localeCompare(right.table_name) ||
        (left.ordinal_position ?? Number.MAX_SAFE_INTEGER) - (right.ordinal_position ?? Number.MAX_SAFE_INTEGER) ||
        left.column_name.localeCompare(right.column_name),
    );
    for (const row of orderedColumnRows) {
      const key = relationKey(schemas, row.schema_name, row.table_name);
      const relation = relations[key];
      const columns = relation === undefined ? {} : { ...relation.columns };
      const generated = /(?:VIRTUAL|STORED) GENERATED/iu
        .exec(row.extra ?? "")?.[0]
        ?.toUpperCase()
        .startsWith("STORED")
        ? "stored"
        : /GENERATED/iu.test(row.extra ?? "")
          ? "virtual"
          : "none";
      const isView = row.table_type === "VIEW" || row.table_type === "SYSTEM VIEW";
      const invisible = /(?:^|\s)INVISIBLE(?:\s|$)/iu.test(row.extra ?? "");
      const characterMaximumLength = optionalCatalogInteger(
        row.character_maximum_length,
        `${row.schema_name}.${row.table_name}.${row.column_name} character length`,
      );
      const numericPrecision = optionalCatalogInteger(
        row.numeric_precision,
        `${row.schema_name}.${row.table_name}.${row.column_name} numeric precision`,
      );
      const numericScale = optionalCatalogInteger(
        row.numeric_scale,
        `${row.schema_name}.${row.table_name}.${row.column_name} numeric scale`,
      );
      const datetimePrecision = optionalCatalogInteger(
        row.datetime_precision,
        `${row.schema_name}.${row.table_name}.${row.column_name} datetime precision`,
      );
      const spatialReferenceSystemId = optionalCatalogInteger(
        row.spatial_reference_system_id,
        `${row.schema_name}.${row.table_name}.${row.column_name} spatial reference system`,
      );
      columns[row.column_name] = {
        name: row.column_name,
        position:
          typeof row.ordinal_position !== "number"
            ? Math.max(-1, ...Object.values(columns).map(({ position }) => position)) + 1
            : Math.max(0, row.ordinal_position - 1),
        databaseType: row.database_type,
        typeIdentity: `mysql:${row.database_type.toLowerCase()}`,
        tsType: mapType(row.database_type),
        nullable: row.is_nullable === "YES",
        nullabilitySource: "declared",
        default: row.default_expression === null ? "unknown" : "present",
        ...(row.default_expression === null
          ? {}
          : { defaultExpressionHash: fingerprintSchemaExpression(row.default_expression) }),
        generated,
        ...(generated === "none" || row.generation_expression === undefined || row.generation_expression === null
          ? {}
          : { generatedExpressionHash: fingerprintSchemaExpression(row.generation_expression) }),
        identity: /auto_increment/iu.test(row.extra ?? "") ? "by-default" : "none",
        ...(row.collation_name === undefined || row.collation_name === null ? {} : { collation: row.collation_name }),
        ...(row.character_set_name === undefined || row.character_set_name === null
          ? {}
          : { characterSet: row.character_set_name }),
        classification: invisible ? "hidden" : "normal",
        insertable: generated === "none" && !isView,
        updatable: generated === "none" && (!isView || row.view_updatable === "YES"),
        extension: {
          version: "1",
          attributes: {
            unsigned: /(?:^|\s)unsigned(?:\s|$)/iu.test(row.database_type),
            zerofill: /(?:^|\s)zerofill(?:\s|$)/iu.test(row.database_type),
            invisible,
            ...(characterMaximumLength === undefined ? {} : { characterMaximumLength }),
            ...(numericPrecision === undefined ? {} : { numericPrecision }),
            ...(numericScale === undefined ? {} : { numericScale }),
            ...(datetimePrecision === undefined ? {} : { datetimePrecision }),
            ...(spatialReferenceSystemId === undefined ? {} : { spatialReferenceSystemId }),
          },
        },
      };
      relations[key] = {
        schema: row.schema_name,
        name: row.table_name,
        kind: isView ? "view" : "table",
        columns,
        constraints: relation?.constraints ?? [],
        indexes: relation?.indexes ?? [],
        capabilities: {
          viewUpdatable: !isView || row.view_updatable === "YES",
          constraintEvidence: catalogEvidence.get("constraints") === "complete",
          indexEvidence: catalogEvidence.get("indexes") === "complete",
        },
      };
      if (types[row.database_type] === undefined) {
        const labels = mySqlEnumValues(row.database_type);
        const setMembers = mySqlSetValues(row.database_type);
        const common = {
          name: row.database_type,
          identity: `mysql:${row.database_type.toLowerCase()}`,
          databaseType: row.database_type,
          tsType: mapType(row.database_type),
        };
        types[row.database_type] =
          labels === undefined
            ? common.tsType === this.#policy.unknown
              ? { kind: "opaque", ...common, reason: "The MySQL type has no configured type-policy mapping." }
              : ({
                  kind: /^set\(/iu.test(row.database_type) ? "collection" : "scalar",
                  ...common,
                  ...(/^set\(/iu.test(row.database_type)
                    ? {
                        elementTypeIdentity: "mysql:string",
                        extension: {
                          version: "1",
                          attributes: { members: setMembers ?? [] },
                        },
                      }
                    : {}),
                } as TypeSnapshot)
            : { kind: "enum", ...common, labels };
      }
    }
    for (const row of normalizeConstraintRows(constraintRows)) {
      const key = relationKey(schemas, row.schema_name, row.table_name);
      const relation = relations[key];
      if (relation === undefined) continue;
      const columns = row.columns.filter((column): column is string => typeof column === "string");
      const referencedColumns = row.referenced_columns.filter((column): column is string => typeof column === "string");
      const base = {
        name: row.constraint_name,
        identity: `${row.schema_name}.${row.table_name}.${row.constraint_name}`,
        columns,
        partial: false,
        expressionBased: false,
        deferrable: false,
        initiallyDeferred: false,
        extension: {
          version: "1",
          attributes: { enforced: row.enforced === undefined ? "unknown" : row.enforced === "YES" },
        },
      } as const;
      const constraint =
        row.constraint_type === "PRIMARY KEY"
          ? ({ kind: "primary-key", ...base, nullsDistinct: false } as const)
          : row.constraint_type === "UNIQUE"
            ? ({ kind: "unique", ...base, nullsDistinct: true } as const)
            : row.constraint_type === "FOREIGN KEY"
              ? ({
                  kind: "foreign-key",
                  ...base,
                  referencedRelation:
                    row.referenced_table === null
                      ? "unknown"
                      : relationKey(schemas, row.referenced_schema ?? row.schema_name, row.referenced_table),
                  referencedColumns,
                  match: "simple",
                  onUpdate: foreignKeyAction(row.update_rule),
                  onDelete: foreignKeyAction(row.delete_rule),
                } as const)
              : ({
                  kind: "check",
                  ...base,
                  expressionBased: true,
                  predicate: row.check_clause === null ? "unknown" : "present",
                  ...(row.check_clause === null
                    ? {}
                    : { predicateHash: fingerprintSchemaExpression(row.check_clause) }),
                } as const);
      relations[key] = { ...relation, constraints: [...relation.constraints, constraint] };
    }
    for (const row of normalizeIndexRows(indexRows)) {
      const key = relationKey(schemas, row.schema_name, row.table_name);
      const relation = relations[key];
      if (relation === undefined) continue;
      const { columns, expressions, descending, column_collations, prefix_lengths } = row;
      const visible = catalogBoolean(row.visible, "index visibility");
      relations[key] = {
        ...relation,
        indexes: [
          ...relation.indexes,
          {
            name: row.index_name,
            identity: `${row.schema_name}.${row.table_name}.${row.index_name}`,
            unique: catalogBoolean(row.is_unique, "index uniqueness"),
            method: row.index_type.toLowerCase(),
            columns: columns.map((value, index) => {
              const column = typeof value === "string" ? value : null;
              const expression = expressions[index];
              const collation = column_collations[index];
              return {
                ...(column === null
                  ? {
                      expressionHash: fingerprintSchemaExpression(
                        typeof expression === "string" ? expression : `${row.index_name}:${index}`,
                      ),
                    }
                  : { column }),
                ...(catalogBoolean(descending[index], "index column ordering") ? { descending: true } : {}),
                ...(typeof collation !== "string" ? {} : { collation }),
              };
            }),
            predicate: "none",
            valid: true,
            extension: {
              version: "1",
              attributes: {
                visible,
                prefixLengths: prefix_lengths.map(
                  (value, index) => optionalCatalogInteger(value, `${row.index_name} prefix length ${index}`) ?? null,
                ),
              },
            },
          },
        ],
      };
    }
    const parameters = new Map<string, ParameterRow[]>();
    for (const row of parameterRows) {
      const key = `${row.schema_name}.${row.routine_name}`;
      const rows = parameters.get(key);
      if (rows === undefined) parameters.set(key, [row]);
      else rows.push(row);
    }
    const routines: Record<string, RoutineSnapshot[]> = {};
    for (const row of catalogEvidence.get("parameters") === "complete" ? routineRows : []) {
      const name = `${row.schema_name}.${row.function_name}`;
      const allParameters = (parameters.get(name) ?? []).sort(
        (left, right) => left.ordinal_position - right.ordinal_position,
      );
      const inputParameters = allParameters.filter(({ ordinal_position }) => ordinal_position > 0);
      const argumentsList = inputParameters.map((parameter) => ({
        ...(parameter.parameter_name === null ? {} : { name: parameter.parameter_name }),
        mode:
          parameter.parameter_mode === "OUT"
            ? ("out" as const)
            : parameter.parameter_mode === "INOUT"
              ? ("inout" as const)
              : ("in" as const),
        typeIdentity: `mysql:${parameter.database_type.toLowerCase()}`,
        databaseType: parameter.database_type,
        tsType: mapType(parameter.database_type),
        default: "none" as const,
      }));
      const kind = row.routine_type === "PROCEDURE" ? "procedure" : "function";
      const routine: RoutineSnapshot = {
        schema: row.schema_name,
        name: row.function_name,
        identity: `${name}(${argumentsList
          .filter(({ mode }) => mode !== "out")
          .map(({ databaseType }) => databaseType)
          .join(",")})`,
        kind,
        arguments: argumentsList,
        result:
          kind === "procedure"
            ? { kind: "command" }
            : {
                kind: "scalar",
                typeIdentity: `mysql:${row.database_return_type.toLowerCase()}`,
                databaseType: row.database_return_type,
                tsType: mapType(row.database_return_type),
                nullable: true,
              },
        volatility: routineVolatility(row),
        deterministic: row.is_deterministic === "YES",
        dataAccess: routineDataAccess(row.sql_data_access),
        nullInput: "called",
        extension: {
          version: "1",
          attributes: {
            ...(row.security_type === undefined ? {} : { securityType: row.security_type.toLowerCase() }),
            ...(row.creation_sql_mode === undefined
              ? {}
              : { creationSqlMode: normalizeCatalogSqlMode(row.creation_sql_mode) }),
            ...(row.creation_character_set == null ? {} : { creationCharacterSet: row.creation_character_set }),
            ...(row.creation_collation == null ? {} : { creationCollation: row.creation_collation }),
            ...(row.database_collation == null ? {} : { databaseCollation: row.database_collation }),
            ...(row.return_character_set == null ? {} : { returnCharacterSet: row.return_character_set }),
            ...(row.return_collation == null ? {} : { returnCollation: row.return_collation }),
            argumentCharacterSets: inputParameters.map(({ character_set_name }) => character_set_name ?? null),
            argumentCollations: inputParameters.map(({ collation_name }) => collation_name ?? null),
          },
        },
      };
      const overloads = routines[name];
      if (overloads === undefined) routines[name] = [routine];
      else overloads.push(routine);
    }
    for (const overloads of Object.values(routines)) {
      overloads.sort(
        (left, right) =>
          left.identity.localeCompare(right.identity) ||
          left.volatility.localeCompare(right.volatility) ||
          String(left.deterministic).localeCompare(String(right.deterministic)),
      );
    }
    const schemaByName = new Map(schemaRows.map((row) => [row.schema_name, row]));
    const namespaces = Object.fromEntries([
      ["def", { name: "def", kind: "catalog" as const }],
      ...schemas.map((name) => {
        const row = schemaByName.get(name);
        return [
          name,
          {
            name,
            kind: "database" as const,
            ...(row === undefined
              ? {}
              : {
                  extension: {
                    version: "1",
                    attributes: {
                      catalog: row.catalog_name,
                      characterSet: row.default_character_set_name,
                      collation: row.default_collation_name,
                    },
                  },
                }),
          },
        ] as const;
      }),
    ]);
    const coreCatalog = mySqlCoreCatalogForSchema(typeContext);
    const snapshot = defineSchemaSnapshotV2({
      formatVersion: 2,
      dialect: "mysql",
      dialectVersion: MYSQL_DIALECT_VERSION,
      server,
      namespaces,
      types,
      relations,
      routines,
      extension: {
        version: "1",
        attributes: {
          catalogRevision: coreCatalog?.revision ?? "unknown",
          evidenceScope: "current-role",
          catalogEvidence: Object.fromEntries(
            [...catalogEvidence.entries()].sort(([left], [right]) => left.localeCompare(right)),
          ),
          incompleteEvidence: diagnostics.length > 0,
          temporaryTables: "not-captured",
        },
      },
    });
    return Object.freeze({ snapshot, diagnostics: Object.freeze([...diagnostics]) });
  }
}

export async function introspectMySql(options: MySqlSchemaProviderOptions): Promise<SchemaSnapshotV2> {
  return new MySqlSchemaProvider(options).introspect({});
}
