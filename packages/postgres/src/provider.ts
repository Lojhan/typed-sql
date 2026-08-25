import type {
  ColumnSnapshot,
  DomainSnapshot,
  FunctionSnapshot,
  SchemaInput,
  SchemaProvider,
  SchemaSnapshot,
  TableSnapshot,
} from "@typed-sql/schema";
import { defaultPostgresTypePolicy, mapPostgresType, type PostgresTypePolicy } from "./type-policy.js";

export interface PostgresQueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface PostgresQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresIntrospectionClient extends PostgresQueryable {
  release(): void;
}

export interface PostgresIntrospectionPool {
  connect(): Promise<PostgresIntrospectionClient>;
  end(): Promise<void>;
}

export interface PostgresDriverModule {
  readonly Pool: new (config: { readonly connectionString: string }) => PostgresIntrospectionPool;
}

export type PostgresDriverImporter = () => Promise<PostgresDriverModule>;

export interface PostgresSchemaProviderOptions {
  readonly client?: PostgresQueryable;
  readonly pool?: PostgresIntrospectionPool;
  readonly includeSchemas?: readonly string[];
  readonly typePolicy?: PostgresTypePolicy;
}

interface ColumnCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly database_type: string;
  readonly not_null: boolean;
  readonly is_array: boolean;
  readonly default_expression: string | null;
}

interface EnumCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly type_name: string;
  readonly enum_label: string;
}

interface DomainCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly domain_name: string;
  readonly database_type: string;
  readonly not_null: boolean;
}

interface FunctionCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly function_name: string;
  readonly argument_types: string[];
  readonly database_return_type: string;
  readonly set_returning: boolean;
}

interface VersionRow extends Record<string, unknown> {
  readonly server_version: string;
}

export const postgresCatalogQueries = {
  version: "SELECT current_setting('server_version') AS server_version",
  columns: `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS database_type,
      a.attnotnull AS not_null,
      (t.typcategory = 'A') AS is_array,
      pg_get_expr(ad.adbin, ad.adrelid) AS default_expression
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef AS ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attnum > 0
      AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, a.attnum
  `,
  enums: `
    SELECT n.nspname AS schema_name, t.typname AS type_name, e.enumlabel AS enum_label
    FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_enum AS e ON e.enumtypid = t.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, t.typname, e.enumsortorder
  `,
  domains: `
    SELECT
      n.nspname AS schema_name,
      t.typname AS domain_name,
      format_type(t.typbasetype, t.typtypmod) AS database_type,
      t.typnotnull AS not_null
    FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE t.typtype = 'd'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, t.typname
  `,
  functions: `
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      ARRAY(
        SELECT format_type(argument_oid, NULL)
        FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS arguments(argument_oid, position)
        ORDER BY position
      ) AS argument_types,
      format_type(p.prorettype, NULL) AS database_return_type,
      p.proretset AS set_returning
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE p.prokind = 'f'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, p.proname, p.oid
  `,
} as const;

function qualifiedKey(schema: string, name: string): string {
  return schema === "public" ? name : `${schema}.${name}`;
}

function redactError(error: unknown, connectionString: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replaceAll(connectionString, "[REDACTED_DATABASE_URL]"));
}

export async function loadPostgresDriver(
  importer: PostgresDriverImporter = async () => (await import("pg")) as unknown as PostgresDriverModule,
): Promise<PostgresDriverModule> {
  try {
    return await importer();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "PostgreSQL introspection requires the application-owned pg driver. Install it with: pnpm add pg",
        { cause: error },
      );
    }
    throw error;
  }
}

async function withConnection<T>(
  input: SchemaInput,
  options: PostgresSchemaProviderOptions,
  fn: (client: PostgresQueryable) => Promise<T>,
): Promise<T> {
  if (options.client !== undefined) return fn(options.client);
  if (input.url === undefined) throw new TypeError("PostgreSQL introspection requires SchemaInput.url");
  const pool: PostgresIntrospectionPool =
    options.pool ?? new (await loadPostgresDriver()).Pool({ connectionString: input.url });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw redactError(error, input.url!);
  });
  const queryable: PostgresQueryable = {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> {
      const result = await client.query<Row>(text, values === undefined ? [] : [...values]);
      return { rows: result.rows };
    },
  };
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await fn(queryable);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Preserve the introspection error. */
    }
    throw redactError(error, input.url);
  } finally {
    client.release();
    await pool.end();
  }
}

export class PostgresSchemaProvider implements SchemaProvider {
  readonly #options: PostgresSchemaProviderOptions;

  constructor(options: PostgresSchemaProviderOptions = {}) {
    this.#options = options;
  }

  async introspect(input: SchemaInput): Promise<SchemaSnapshot> {
    return withConnection(input, this.#options, async (client) => {
      const schemaFilter = this.#options.includeSchemas === undefined ? null : [...this.#options.includeSchemas];
      const values: readonly unknown[] = [schemaFilter];
      const [versionResult, enumResult, domainResult, columnResult, functionResult] = await Promise.all([
        client.query<VersionRow>(postgresCatalogQueries.version),
        client.query<EnumCatalogRow>(postgresCatalogQueries.enums, values),
        client.query<DomainCatalogRow>(postgresCatalogQueries.domains, values),
        client.query<ColumnCatalogRow>(postgresCatalogQueries.columns, values),
        client.query<FunctionCatalogRow>(postgresCatalogQueries.functions, values),
      ]);

      const enums: Record<string, string[]> = {};
      for (const row of enumResult.rows) {
        const key = qualifiedKey(row.schema_name, row.type_name);
        const values = enums[key];
        if (values === undefined) enums[key] = [row.enum_label];
        else values.push(row.enum_label);
      }

      const policy = this.#options.typePolicy ?? defaultPostgresTypePolicy;
      const domains: Record<string, DomainSnapshot> = {};
      for (const row of domainResult.rows) {
        const key = qualifiedKey(row.schema_name, row.domain_name);
        domains[key] = {
          name: row.domain_name,
          databaseType: row.database_type,
          tsType: mapPostgresType(row.database_type, policy),
          nullable: !row.not_null,
        };
      }

      const partialSchema: SchemaSnapshot = { formatVersion: 1, dialect: "postgres", tables: {}, enums, domains };
      const tables: Record<string, TableSnapshot> = {};
      for (const row of columnResult.rows) {
        const tableKey = qualifiedKey(row.schema_name, row.table_name);
        const existing = tables[tableKey];
        const columns: Record<string, ColumnSnapshot> = existing === undefined ? {} : { ...existing.columns };
        const domain = domains[row.database_type];
        columns[row.column_name] = {
          name: row.column_name,
          databaseType: row.database_type,
          tsType: mapPostgresType(row.database_type, policy, partialSchema),
          nullable: !row.not_null && (domain?.nullable ?? true),
          ...(row.is_array ? { array: true } : {}),
          ...(row.default_expression === null ? {} : { defaultExpression: row.default_expression }),
        };
        tables[tableKey] = { schema: row.schema_name, name: row.table_name, columns };
      }

      const schemaForFunctions: SchemaSnapshot = { ...partialSchema, tables };
      const functions: Record<string, FunctionSnapshot> = {};
      for (const row of functionResult.rows) {
        const name = qualifiedKey(row.schema_name, row.function_name);
        const key = `${name}(${row.argument_types.join(",")})`;
        functions[key] = {
          name: row.function_name,
          schema: row.schema_name,
          argumentTypes: row.argument_types,
          databaseReturnType: row.database_return_type,
          returnType: mapPostgresType(row.database_return_type, policy, schemaForFunctions),
          nullable: true,
          ...(row.set_returning ? { setReturning: true } : {}),
        };
      }

      const version = versionResult.rows[0]?.server_version;
      return {
        formatVersion: 1,
        dialect: "postgres",
        ...(version === undefined ? {} : { version }),
        tables,
        ...(Object.keys(enums).length === 0 ? {} : { enums }),
        ...(Object.keys(domains).length === 0 ? {} : { domains }),
        ...(Object.keys(functions).length === 0 ? {} : { functions }),
      };
    });
  }
}

export async function introspectPostgres(
  input: SchemaInput,
  options: PostgresSchemaProviderOptions = {},
): Promise<SchemaSnapshot> {
  return new PostgresSchemaProvider(options).introspect(input);
}
