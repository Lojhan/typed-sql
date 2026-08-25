import type { SchemaInput, SchemaProvider, SchemaSnapshot } from "@typed-sql/schema";
import { defaultMySqlTypePolicy, type MySqlTypePolicy, mapMySqlType } from "./type-policy.js";

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

interface VersionRow extends Record<string, unknown> {
  readonly server_version: string;
}
interface DatabaseRow extends Record<string, unknown> {
  readonly database_name: string | null;
}
interface ColumnRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly database_type: string;
  readonly is_nullable: "YES" | "NO";
  readonly default_expression: string | null;
}
interface RoutineRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly function_name: string;
  readonly database_return_type: string;
}

export const mysqlCatalogQueries = Object.freeze({
  version: "SELECT VERSION() AS server_version",
  database: "SELECT DATABASE() AS database_name",
  columns(schemaCount: number): string {
    return `
      SELECT TABLE_SCHEMA AS schema_name,
             TABLE_NAME AS table_name,
             COLUMN_NAME AS column_name,
             COLUMN_TYPE AS database_type,
             IS_NULLABLE AS is_nullable,
             COLUMN_DEFAULT AS default_expression
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    `;
  },
  routines(schemaCount: number): string {
    return `
      SELECT ROUTINE_SCHEMA AS schema_name,
             ROUTINE_NAME AS function_name,
             DTD_IDENTIFIER AS database_return_type
      FROM information_schema.ROUTINES
      WHERE ROUTINE_TYPE = 'FUNCTION'
        AND ROUTINE_SCHEMA IN (${Array.from({ length: schemaCount }, () => "?").join(", ")})
      ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME
    `;
  },
});

export class MySqlSchemaProvider implements SchemaProvider {
  readonly #client: MySqlQueryable | undefined;
  readonly #schemas: readonly string[] | undefined;
  readonly #policy: MySqlTypePolicy;

  constructor(options: MySqlSchemaProviderOptions = {}) {
    this.#client = options.client;
    this.#schemas = options.includeSchemas;
    this.#policy = options.typePolicy ?? defaultMySqlTypePolicy;
  }

  async introspect(_input: SchemaInput): Promise<SchemaSnapshot> {
    if (this.#client === undefined)
      throw new TypeError(
        "MySQL schema provider requires an injected client; use @typed-sql/mysql/mysql2 for a connection URI",
      );
    const version = (await this.#client.query<VersionRow>(mysqlCatalogQueries.version)).rows[0]?.server_version;
    const currentDatabase = (await this.#client.query<DatabaseRow>(mysqlCatalogQueries.database)).rows[0]
      ?.database_name;
    const schemas =
      this.#schemas ?? (currentDatabase === null || currentDatabase === undefined ? [] : [currentDatabase]);
    if (schemas.length === 0) throw new TypeError("MySQL introspection requires at least one database schema");
    const columnRows = (await this.#client.query<ColumnRow>(mysqlCatalogQueries.columns(schemas.length), schemas)).rows;
    const routineRows = (await this.#client.query<RoutineRow>(mysqlCatalogQueries.routines(schemas.length), schemas))
      .rows;
    const tables: Record<
      string,
      {
        schema: string;
        name: string;
        columns: Record<
          string,
          { name: string; databaseType: string; tsType: string; nullable: boolean; defaultExpression?: string }
        >;
      }
    > = {};
    for (const row of columnRows) {
      const key = schemas.length === 1 ? row.table_name : `${row.schema_name}.${row.table_name}`;
      let table = tables[key];
      if (table === undefined) {
        table = { schema: row.schema_name, name: row.table_name, columns: {} };
        tables[key] = table;
      }
      table.columns[row.column_name] = {
        name: row.column_name,
        databaseType: row.database_type,
        tsType: mapMySqlType(row.database_type, this.#policy),
        nullable: row.is_nullable === "YES",
        ...(row.default_expression === null ? {} : { defaultExpression: row.default_expression }),
      };
    }
    const functions: Record<
      string,
      {
        schema: string;
        name: string;
        argumentTypes: readonly string[];
        databaseReturnType: string;
        returnType: string;
        nullable: boolean;
      }
    > = {};
    for (const row of routineRows) {
      functions[`${row.schema_name}.${row.function_name}()`] = {
        schema: row.schema_name,
        name: row.function_name,
        argumentTypes: [],
        databaseReturnType: row.database_return_type,
        returnType: mapMySqlType(row.database_return_type, this.#policy),
        nullable: true,
      };
    }
    return {
      formatVersion: 1,
      dialect: "mysql",
      dialectVersion: "1.0.0",
      ...(version === undefined ? {} : { version }),
      tables,
      ...(Object.keys(functions).length === 0 ? {} : { functions }),
    };
  }
}

export async function introspectMySql(options: MySqlSchemaProviderOptions): Promise<SchemaSnapshot> {
  return new MySqlSchemaProvider(options).introspect({});
}
