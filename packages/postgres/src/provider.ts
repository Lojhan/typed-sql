import type {
  DomainSnapshot,
  ForeignKeyAction,
  IndexSnapshot,
  RelationSnapshot,
  RoutineArgumentMode,
  RoutineSnapshot,
  SchemaInput,
  SchemaProvider,
  SchemaSnapshotV1,
  SchemaSnapshotV2,
  TypeSnapshot,
} from "@typed-sql/schema";
import { defineSchemaSnapshotV2, fingerprintSchemaExpression } from "@typed-sql/schema";
import { postgresServerEvidence } from "./capabilities.js";
import { fingerprintPostgresExpressionSql } from "./expression-evidence.js";
import { defaultPostgresTypePolicy, mapPostgresType, type PostgresTypePolicy } from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

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
  readonly column_position?: number;
  readonly relation_kind?: "r" | "p" | "v" | "m" | "f";
  readonly type_identity?: string;
  readonly generated_kind?: "" | "s";
  readonly identity_kind?: "" | "a" | "d";
  readonly collation_name?: string | null;
  readonly insertable?: boolean;
  readonly updatable?: boolean;
}

interface RelationCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly relation_kind: "r" | "p" | "v" | "m" | "f";
  readonly is_partition: boolean;
  readonly partition_parent_schema: string | null;
  readonly partition_parent_table: string | null;
  readonly partition_strategy: "h" | "l" | "r" | null;
}

interface EnumCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly type_name: string;
  readonly enum_label: string;
  readonly enum_position?: number;
}

interface DomainCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly domain_name: string;
  readonly database_type: string;
  readonly not_null: boolean;
  readonly type_identity?: string;
  readonly check_expressions?: readonly string[];
}

interface FunctionCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly function_name: string;
  readonly argument_types: string[];
  readonly database_return_type: string;
  readonly set_returning: boolean;
  readonly volatility: "i" | "s" | "v";
  readonly routine_identity?: string;
  readonly routine_kind?: "f" | "p" | "a" | "w";
  readonly argument_names?: readonly (string | null)[];
  readonly argument_modes?: readonly ("i" | "o" | "b" | "v" | "t")[];
  readonly argument_defaults?: number;
  readonly strict?: boolean;
  readonly parallel_safety?: "r" | "s" | "u";
}

interface ConstraintCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly constraint_name: string;
  readonly constraint_type: "p" | "u" | "f" | "c" | "x";
  readonly columns: readonly string[];
  readonly referenced_schema?: string | null;
  readonly referenced_table?: string | null;
  readonly referenced_columns?: readonly string[] | null;
  readonly match_type?: "f" | "p" | "s";
  readonly update_action?: "a" | "r" | "c" | "n" | "d";
  readonly delete_action?: "a" | "r" | "c" | "n" | "d";
  readonly deferrable: boolean;
  readonly initially_deferred: boolean;
  readonly nulls_not_distinct?: boolean | null;
  readonly expression_based?: boolean;
  readonly predicate_expression?: string | null;
  readonly exclusion_operators?: readonly string[] | null;
}

interface IndexCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
  readonly index_name: string;
  readonly unique: boolean;
  readonly method: string;
  readonly key_columns: readonly (string | null)[];
  readonly key_expressions: readonly (string | null)[];
  readonly descending: readonly boolean[];
  readonly nulls_first: readonly boolean[];
  readonly operator_classes: readonly (string | null)[];
  readonly collations: readonly (string | null)[];
  readonly included_columns: readonly string[];
  readonly predicate_expression: string | null;
  readonly valid: boolean;
}

interface CompositeCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly type_name: string;
  readonly type_identity: string;
  readonly field_name: string;
  readonly field_type_identity: string;
  readonly field_database_type: string;
  readonly field_not_null: boolean;
  readonly field_position?: number;
}

interface RangeCatalogRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly type_name: string;
  readonly type_identity: string;
  readonly database_type: string;
  readonly subtype_identity: string;
  readonly multirange: boolean;
}

interface VersionRow extends Record<string, unknown> {
  readonly server_version: string;
  readonly standard_conforming_strings?: string;
  readonly search_path?: string;
  readonly extensions?: readonly string[];
}

export const postgresCatalogQueries = {
  version: `
    SELECT current_setting('server_version') AS server_version,
           current_setting('standard_conforming_strings') AS standard_conforming_strings,
           current_setting('search_path') AS search_path,
           ARRAY(SELECT extname || ':' || extversion FROM pg_catalog.pg_extension ORDER BY extname) AS extensions
  `,
  relations: `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      c.relkind AS relation_kind,
      c.relispartition AS is_partition,
      pn.nspname AS partition_parent_schema,
      pc.relname AS partition_parent_table,
      pt.partstrat AS partition_strategy
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_inherits AS inh ON inh.inhrelid = c.oid AND c.relispartition
    LEFT JOIN pg_catalog.pg_class AS pc ON pc.oid = inh.inhparent
    LEFT JOIN pg_catalog.pg_namespace AS pn ON pn.oid = pc.relnamespace
    LEFT JOIN pg_catalog.pg_partitioned_table AS pt ON pt.partrelid = c.oid
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname
  `,
  columns: `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      a.attname AS column_name,
      (a.attnum - 1) AS column_position,
      c.relkind AS relation_kind,
      format_type(a.atttypid, a.atttypmod) AS database_type,
      'pg:' || a.atttypid::text AS type_identity,
      a.attnotnull AS not_null,
      (t.typcategory = 'A') AS is_array,
      pg_get_expr(ad.adbin, ad.adrelid) AS default_expression,
      a.attgenerated AS generated_kind,
      a.attidentity AS identity_kind,
      CASE WHEN a.attcollation = 0 THEN NULL ELSE quote_ident(cn.nspname) || '.' || quote_ident(coll.collname) END AS collation_name,
      ((pg_relation_is_updatable(c.oid, true) & 8) = 8 AND a.attgenerated = '') AS insertable,
      ((pg_relation_is_updatable(c.oid, true) & 4) = 4 AND a.attgenerated = '') AS updatable
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef AS ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    LEFT JOIN pg_catalog.pg_collation AS coll ON coll.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_namespace AS cn ON cn.oid = coll.collnamespace
    WHERE a.attnum > 0
      AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, a.attnum
  `,
  enums: `
    SELECT n.nspname AS schema_name, t.typname AS type_name, e.enumlabel AS enum_label,
           e.enumsortorder::double precision AS enum_position
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
      'pg:' || t.oid::text AS type_identity,
      format_type(t.typbasetype, t.typtypmod) AS database_type,
      t.typnotnull AS not_null,
      ARRAY(
        SELECT pg_get_constraintdef(con.oid, true)
        FROM pg_catalog.pg_constraint AS con
        WHERE con.contypid = t.oid
        ORDER BY con.conname
      ) AS check_expressions
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
      'pg:' || p.oid::text AS routine_identity,
      p.prokind AS routine_kind,
      ARRAY(
        SELECT format_type(argument_oid, NULL)
        FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS arguments(argument_oid, position)
        ORDER BY position
      ) AS argument_types,
      COALESCE(p.proargnames, ARRAY[]::text[]) AS argument_names,
      ARRAY(
        SELECT mode::text
        FROM unnest(COALESCE(p.proargmodes, ARRAY[]::"char"[])) WITH ORDINALITY AS modes(mode, position)
        ORDER BY position
      ) AS argument_modes,
      p.pronargdefaults AS argument_defaults,
      format_type(p.prorettype, NULL) AS database_return_type,
      p.proretset AS set_returning,
      p.provolatile AS volatility,
      p.proisstrict AS strict,
      p.proparallel AS parallel_safety
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p', 'a', 'w')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, p.proname, p.oid
  `,
  constraints(serverMajor: number): string {
    const nullsNotDistinct = serverMajor >= 15 ? "i.indnullsnotdistinct" : "NULL::boolean";
    return `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      con.conname AS constraint_name,
      con.contype AS constraint_type,
      ARRAY(
        SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS keys(attnum, position)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = con.conrelid AND a.attnum = keys.attnum
        ORDER BY keys.position
      ) AS columns,
      rn.nspname AS referenced_schema,
      rc.relname AS referenced_table,
      ARRAY(
        SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS keys(attnum, position)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = con.confrelid AND a.attnum = keys.attnum
        ORDER BY keys.position
      ) AS referenced_columns,
      con.confmatchtype AS match_type,
      con.confupdtype AS update_action,
      con.confdeltype AS delete_action,
      con.condeferrable AS deferrable,
      con.condeferred AS initially_deferred,
      ${nullsNotDistinct} AS nulls_not_distinct,
      (array_position(con.conkey, 0) IS NOT NULL) AS expression_based,
      CASE
        WHEN con.contype = 'c' THEN pg_get_expr(con.conbin, con.conrelid)
        WHEN con.contype = 'x' THEN pg_get_expr(i.indpred, i.indrelid)
        ELSE NULL
      END AS predicate_expression,
      CASE WHEN con.contype = 'x' THEN ARRAY(SELECT opr::regoperator::text FROM unnest(con.conexclop) AS opr) ELSE NULL END
        AS exclusion_operators
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_class AS rc ON rc.oid = con.confrelid
    LEFT JOIN pg_catalog.pg_namespace AS rn ON rn.oid = rc.relnamespace
    LEFT JOIN pg_catalog.pg_index AS i ON i.indexrelid = con.conindid
    WHERE con.contype IN ('p', 'u', 'f', 'c', 'x')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, con.conname
  `;
  },
  indexes: `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      ic.relname AS index_name,
      i.indisunique AS unique,
      am.amname AS method,
      ARRAY(
        SELECT CASE WHEN keys.attnum = 0 THEN NULL ELSE a.attname::text END
        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS keys(attnum, position)
        LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = keys.attnum
        WHERE keys.position <= i.indnkeyatts ORDER BY keys.position
      ) AS key_columns,
      ARRAY(
        SELECT CASE WHEN keys.attnum = 0 THEN pg_get_indexdef(i.indexrelid, keys.position::int, true) ELSE NULL END
        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS keys(attnum, position)
        WHERE keys.position <= i.indnkeyatts ORDER BY keys.position
      ) AS key_expressions,
      ARRAY(SELECT ((i.indoption[position - 1] & 1) = 1) FROM generate_series(1, i.indnkeyatts) AS position)
        AS descending,
      ARRAY(SELECT ((i.indoption[position - 1] & 2) = 2) FROM generate_series(1, i.indnkeyatts) AS position)
        AS nulls_first,
      ARRAY(
        SELECT opc.opcname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY AS classes(oid, position)
        JOIN pg_catalog.pg_opclass AS opc ON opc.oid = classes.oid ORDER BY classes.position
      ) AS operator_classes,
      ARRAY(
        SELECT CASE WHEN collations.oid = 0 THEN NULL ELSE coll.collname::text END
        FROM unnest(i.indcollation::oid[]) WITH ORDINALITY AS collations(oid, position)
        LEFT JOIN pg_catalog.pg_collation AS coll ON coll.oid = collations.oid ORDER BY collations.position
      ) AS collations,
      ARRAY(
        SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS keys(attnum, position)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = keys.attnum
        WHERE keys.position > i.indnkeyatts ORDER BY keys.position
      ) AS included_columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate_expression,
      i.indisvalid AS valid
    FROM pg_catalog.pg_index AS i
    JOIN pg_catalog.pg_class AS c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_class AS ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_am AS am ON am.oid = ic.relam
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, ic.relname
  `,
  composites: `
    SELECT n.nspname AS schema_name, t.typname AS type_name, 'pg:' || t.oid::text AS type_identity,
           a.attname AS field_name, 'pg:' || a.atttypid::text AS field_type_identity,
           format_type(a.atttypid, a.atttypmod) AS field_database_type, a.attnotnull AS field_not_null,
           a.attnum AS field_position
    FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_class AS c ON c.oid = t.typrelid
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE t.typtype = 'c' AND c.relkind = 'c'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, t.typname, a.attnum
  `,
  ranges: `
    SELECT n.nspname AS schema_name, t.typname AS type_name, 'pg:' || t.oid::text AS type_identity,
           format_type(t.oid, NULL) AS database_type, 'pg:' || r.rngsubtype::text AS subtype_identity, false AS multirange
    FROM pg_catalog.pg_range AS r
    JOIN pg_catalog.pg_type AS t ON t.oid = r.rngtypid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    UNION ALL
    SELECT n.nspname AS schema_name, t.typname AS type_name, 'pg:' || t.oid::text AS type_identity,
           format_type(t.oid, NULL) AS database_type, 'pg:' || r.rngsubtype::text AS subtype_identity, true AS multirange
    FROM pg_catalog.pg_range AS r
    JOIN pg_catalog.pg_type AS t ON t.oid = r.rngmultitypid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE r.rngmultitypid <> 0
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY schema_name, type_name
  `,
} as const;

function qualifiedKey(schema: string, name: string): string {
  return schema === "public" ? name : `${schema}.${name}`;
}

function relationKind(kind: ColumnCatalogRow["relation_kind"]): RelationSnapshot["kind"] {
  if (kind === "v") return "view";
  if (kind === "m") return "materialized-view";
  if (kind === "f") return "foreign-table";
  return "table";
}

function foreignKeyAction(action: ConstraintCatalogRow["update_action"]): ForeignKeyAction {
  if (action === "r") return "restrict";
  if (action === "c") return "cascade";
  if (action === "n") return "set-null";
  if (action === "d") return "set-default";
  if (action === "a") return "no-action";
  return "unknown";
}

function argumentMode(mode: "i" | "o" | "b" | "v" | "t" | undefined): RoutineArgumentMode {
  if (mode === "o" || mode === "t") return "out";
  if (mode === "b") return "inout";
  if (mode === "v") return "variadic";
  return "in";
}

function routineKind(kind: FunctionCatalogRow["routine_kind"]): RoutineSnapshot["kind"] {
  if (kind === "p") return "procedure";
  if (kind === "a") return "aggregate";
  if (kind === "w") return "window";
  return "function";
}

function partitionStrategy(strategy: RelationCatalogRow["partition_strategy"]): string | undefined {
  if (strategy === "h") return "hash";
  if (strategy === "l") return "list";
  if (strategy === "r") return "range";
  return undefined;
}

function parallelSafety(safety: FunctionCatalogRow["parallel_safety"]): string {
  if (safety === "r") return "restricted";
  if (safety === "s") return "safe";
  if (safety === "u") return "unsafe";
  return "unknown";
}

function polymorphicFamily(types: readonly string[]): string | undefined {
  if (types.some((type) => /^anycompatible/u.test(type))) return "postgres-anycompatible";
  if (types.some((type) => /^any/u.test(type))) return "postgres-anyelement";
  return undefined;
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

export class PostgresSchemaProvider implements SchemaProvider<SchemaSnapshotV2> {
  readonly #options: PostgresSchemaProviderOptions;

  constructor(options: PostgresSchemaProviderOptions = {}) {
    this.#options = options;
  }

  async introspect(input: SchemaInput): Promise<SchemaSnapshotV2> {
    return withConnection(input, this.#options, async (client) => {
      const schemaFilter = this.#options.includeSchemas === undefined ? null : [...this.#options.includeSchemas];
      const values: readonly unknown[] = [schemaFilter];
      const versionResult = await client.query<VersionRow>(postgresCatalogQueries.version);
      const serverRow = versionResult.rows[0];
      if (serverRow === undefined) throw new TypeError("PostgreSQL introspection did not return a server version");
      const version = serverRow.server_version;
      const serverMajor = Number.parseInt(version, 10);
      // A pg Client supports one active query. Keep catalog reads sequential inside the same
      // repeatable-read transaction so this remains valid with pg 9 and driver-compatible clients.
      const enumResult = await client.query<EnumCatalogRow>(postgresCatalogQueries.enums, values);
      const domainResult = await client.query<DomainCatalogRow>(postgresCatalogQueries.domains, values);
      const relationResult = await client.query<RelationCatalogRow>(postgresCatalogQueries.relations, values);
      const columnResult = await client.query<ColumnCatalogRow>(postgresCatalogQueries.columns, values);
      const functionResult = await client.query<FunctionCatalogRow>(postgresCatalogQueries.functions, values);
      const constraintResult = await client.query<ConstraintCatalogRow>(
        postgresCatalogQueries.constraints(serverMajor),
        values,
      );
      const indexResult = await client.query<IndexCatalogRow>(postgresCatalogQueries.indexes, values);
      const compositeResult = await client.query<CompositeCatalogRow>(postgresCatalogQueries.composites, values);
      const rangeResult = await client.query<RangeCatalogRow>(postgresCatalogQueries.ranges, values);

      const enumRows = new Map<string, EnumCatalogRow[]>();
      for (const row of enumResult.rows) {
        const key = qualifiedKey(row.schema_name, row.type_name);
        const rows = enumRows.get(key);
        if (rows === undefined) enumRows.set(key, [row]);
        else rows.push(row);
      }
      const enums = Object.fromEntries(
        [...enumRows]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, rows]) => [
            key,
            rows
              .sort((left, right) => (left.enum_position ?? 0) - (right.enum_position ?? 0))
              .map(({ enum_label }) => enum_label),
          ]),
      );

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

      const partialSchema: SchemaSnapshotV1 = { formatVersion: 1, dialect: "postgres", tables: {}, enums, domains };
      const types: Record<string, TypeSnapshot> = {};
      for (const [key, labels] of Object.entries(enums)) {
        const schemaName = enumResult.rows.find(
          (row) => qualifiedKey(row.schema_name, row.type_name) === key,
        )?.schema_name;
        const name = key.slice(key.lastIndexOf(".") + 1);
        types[key] = {
          kind: "enum",
          name,
          ...(schemaName === undefined ? {} : { schema: schemaName }),
          identity: `postgres:${schemaName ?? "public"}.${name}`,
          databaseType: key,
          tsType: mapPostgresType(key, policy, partialSchema),
          labels,
        };
      }
      for (const [key, domain] of Object.entries(domains)) {
        const row = domainResult.rows.find((item) => qualifiedKey(item.schema_name, item.domain_name) === key);
        types[key] = {
          kind: "domain",
          name: domain.name,
          ...(row === undefined ? {} : { schema: row.schema_name }),
          identity: row?.type_identity ?? `postgres:${key}`,
          databaseType: domain.databaseType,
          tsType: domain.tsType,
          baseTypeIdentity: domain.databaseType,
          nullable: domain.nullable,
          checks: (row?.check_expressions ?? []).map(fingerprintSchemaExpression).sort(),
        };
      }
      const compositeGroups = new Map<string, CompositeCatalogRow[]>();
      for (const row of compositeResult.rows) {
        const key = qualifiedKey(row.schema_name, row.type_name);
        const rows = compositeGroups.get(key);
        if (rows === undefined) compositeGroups.set(key, [row]);
        else rows.push(row);
      }
      for (const [key, rows] of compositeGroups) {
        const first = rows[0]!;
        types[key] = {
          kind: "composite",
          name: first.type_name,
          schema: first.schema_name,
          identity: first.type_identity,
          databaseType: key,
          tsType: "unknown",
          fields: rows
            .sort((left, right) => (left.field_position ?? 0) - (right.field_position ?? 0))
            .map((row) => ({
              name: row.field_name,
              typeIdentity: row.field_type_identity,
              databaseType: row.field_database_type,
              tsType: mapPostgresType(row.field_database_type, policy, partialSchema),
              nullable: !row.field_not_null,
            })),
        };
      }
      for (const row of rangeResult.rows) {
        const key = qualifiedKey(row.schema_name, row.type_name);
        types[key] = {
          kind: row.multirange ? "multirange" : "range",
          name: row.type_name,
          schema: row.schema_name,
          identity: row.type_identity,
          databaseType: row.database_type,
          tsType: mapPostgresType(row.database_type, policy, partialSchema),
          subtypeIdentity: row.subtype_identity,
        };
      }

      const relations: Record<string, RelationSnapshot> = {};
      for (const row of relationResult.rows) {
        const parent =
          row.partition_parent_table === null
            ? undefined
            : qualifiedKey(row.partition_parent_schema ?? "public", row.partition_parent_table);
        const strategy = partitionStrategy(row.partition_strategy);
        const capabilities = {
          ...(row.relation_kind === "p" ? { partitioned: true } : {}),
          ...(row.is_partition ? { partition: true } : {}),
          ...(parent === undefined ? {} : { partitionParent: parent }),
          ...(strategy === undefined ? {} : { partitionStrategy: strategy }),
        };
        relations[qualifiedKey(row.schema_name, row.table_name)] = {
          schema: row.schema_name,
          name: row.table_name,
          kind: relationKind(row.relation_kind),
          columns: {},
          constraints: [],
          indexes: [],
          ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
        };
      }
      for (const row of columnResult.rows) {
        const tableKey = qualifiedKey(row.schema_name, row.table_name);
        const existing = relations[tableKey];
        const columns = existing === undefined ? {} : { ...existing.columns };
        const domain = domains[row.database_type];
        columns[row.column_name] = {
          name: row.column_name,
          position: row.column_position ?? Object.keys(columns).length,
          databaseType: row.database_type,
          typeIdentity: row.type_identity ?? row.database_type,
          tsType: mapPostgresType(row.database_type, policy, partialSchema),
          nullable: !row.not_null && (domain?.nullable ?? true),
          nullabilitySource: domain === undefined ? "declared" : "domain",
          default: row.generated_kind === "s" ? "none" : row.default_expression === null ? "none" : "present",
          ...(row.default_expression === null || row.generated_kind === "s"
            ? {}
            : { defaultExpressionHash: fingerprintSchemaExpression(row.default_expression) }),
          generated: row.generated_kind === "s" ? "stored" : "none",
          ...(row.generated_kind === "s" && row.default_expression !== null
            ? { generatedExpressionHash: fingerprintSchemaExpression(row.default_expression) }
            : {}),
          identity: row.identity_kind === "a" ? "always" : row.identity_kind === "d" ? "by-default" : "none",
          ...(row.collation_name === undefined || row.collation_name === null ? {} : { collation: row.collation_name }),
          ...(row.is_array ? { dimensions: [] } : {}),
          classification: "normal",
          insertable: row.insertable ?? (row.relation_kind !== "v" && row.relation_kind !== "m"),
          updatable: row.updatable ?? (row.relation_kind !== "v" && row.relation_kind !== "m"),
        };
        relations[tableKey] = {
          schema: row.schema_name,
          name: row.table_name,
          kind: relationKind(row.relation_kind),
          columns,
          constraints: existing?.constraints ?? [],
          indexes: existing?.indexes ?? [],
          ...(existing?.capabilities === undefined ? {} : { capabilities: existing.capabilities }),
        };
      }
      for (const row of columnResult.rows) {
        if (types[row.database_type] !== undefined) continue;
        const tsType = mapPostgresType(row.database_type, policy, partialSchema);
        const common = {
          name: row.database_type,
          identity: row.type_identity ?? row.database_type,
          databaseType: row.database_type,
          tsType,
        };
        types[row.database_type] = row.is_array
          ? {
              kind: "collection",
              ...common,
              elementTypeIdentity: row.database_type.replace(/\[\]$/u, ""),
              dimensions: [],
            }
          : tsType === policy.unknown
            ? {
                kind: "opaque",
                ...common,
                reason: "The PostgreSQL type has no configured type-policy mapping.",
              }
            : { kind: "scalar", ...common };
      }
      for (const row of constraintResult.rows) {
        const relationKey = qualifiedKey(row.schema_name, row.table_name);
        const relation = relations[relationKey];
        if (relation === undefined) continue;
        const base = {
          name: row.constraint_name,
          identity: `${row.schema_name}.${row.table_name}.${row.constraint_name}`,
          columns: row.columns,
          partial:
            row.predicate_expression === null ? false : row.predicate_expression === undefined ? "unknown" : true,
          expressionBased: row.expression_based ?? false,
          deferrable: row.deferrable,
          initiallyDeferred: row.initially_deferred,
        } as const;
        const constraint =
          row.constraint_type === "p"
            ? ({ kind: "primary-key", ...base, nullsDistinct: false } as const)
            : row.constraint_type === "u"
              ? ({
                  kind: "unique",
                  ...base,
                  nullsDistinct: row.nulls_not_distinct == null ? "unknown" : !row.nulls_not_distinct,
                } as const)
              : row.constraint_type === "f"
                ? ({
                    kind: "foreign-key",
                    ...base,
                    referencedRelation:
                      row.referenced_table === undefined || row.referenced_table === null
                        ? "unknown"
                        : qualifiedKey(row.referenced_schema ?? "public", row.referenced_table),
                    referencedColumns: row.referenced_columns ?? [],
                    match: row.match_type === "f" ? "full" : row.match_type === "p" ? "partial" : "simple",
                    onUpdate: foreignKeyAction(row.update_action),
                    onDelete: foreignKeyAction(row.delete_action),
                  } as const)
                : row.constraint_type === "c"
                  ? ({
                      kind: "check",
                      ...base,
                      predicate: row.predicate_expression === undefined ? "unknown" : "present",
                      ...(row.predicate_expression === undefined || row.predicate_expression === null
                        ? {}
                        : { predicateHash: fingerprintPostgresExpressionSql(row.predicate_expression) }),
                    } as const)
                  : ({
                      kind: "exclusion",
                      ...base,
                      elements: (row.exclusion_operators ?? []).map((operator, index) => ({
                        ...(row.columns[index] === undefined
                          ? { expressionHash: fingerprintSchemaExpression(`${base.identity}:${index}`) }
                          : { column: row.columns[index] }),
                        operator,
                      })),
                      ...(row.predicate_expression === undefined || row.predicate_expression === null
                        ? {}
                        : { predicateHash: fingerprintPostgresExpressionSql(row.predicate_expression) }),
                    } as const);
        relations[relationKey] = { ...relation, constraints: [...relation.constraints, constraint] };
      }
      for (const row of indexResult.rows) {
        const relationKey = qualifiedKey(row.schema_name, row.table_name);
        const relation = relations[relationKey];
        if (relation === undefined) continue;
        const index: IndexSnapshot = {
          name: row.index_name,
          identity: `${row.schema_name}.${row.table_name}.${row.index_name}`,
          unique: row.unique,
          method: row.method,
          columns: row.key_columns.map((column, offset) => ({
            ...(column === null
              ? {
                  expressionHash: fingerprintPostgresExpressionSql(
                    row.key_expressions[offset] ?? `${row.index_name}:${offset}`,
                  ),
                }
              : { column }),
            ...(row.descending[offset] ? { descending: true } : {}),
            nulls: row.nulls_first[offset] ? "first" : "last",
            ...(row.operator_classes[offset] === undefined || row.operator_classes[offset] === null
              ? {}
              : { operatorClass: row.operator_classes[offset] }),
            ...(row.collations[offset] === undefined || row.collations[offset] === null
              ? {}
              : { collation: row.collations[offset] }),
          })),
          ...(row.included_columns.length === 0 ? {} : { includedColumns: row.included_columns }),
          predicate: row.predicate_expression === null ? "none" : "present",
          ...(row.predicate_expression === null
            ? {}
            : { predicateHash: fingerprintPostgresExpressionSql(row.predicate_expression) }),
          valid: row.valid,
        };
        relations[relationKey] = { ...relation, indexes: [...relation.indexes, index] };
      }

      const schemaForFunctions: SchemaSnapshotV1 = {
        ...partialSchema,
        tables: Object.fromEntries(
          Object.entries(relations).map(([key, relation]) => [
            key,
            {
              name: relation.name,
              ...(relation.schema === undefined ? {} : { schema: relation.schema }),
              columns: Object.fromEntries(
                Object.entries(relation.columns).map(([columnKey, column]) => [
                  columnKey,
                  {
                    name: column.name,
                    databaseType: column.databaseType,
                    tsType: column.tsType,
                    nullable: column.nullable,
                  },
                ]),
              ),
            },
          ]),
        ),
      };
      const routines: Record<string, RoutineSnapshot[]> = {};
      for (const row of functionResult.rows) {
        const name = qualifiedKey(row.schema_name, row.function_name);
        const modes = row.argument_modes ?? [];
        const inputPositions = row.argument_types
          .map((_, index) => index)
          .filter((index) => argumentMode(modes[index]) !== "out");
        const defaultStart = inputPositions.length - (row.argument_defaults ?? 0);
        const argumentsList = row.argument_types.map((databaseType, index) => ({
          ...(row.argument_names?.[index] == null ? {} : { name: row.argument_names[index]! }),
          mode: argumentMode(modes[index]),
          typeIdentity: databaseType,
          databaseType,
          tsType: mapPostgresType(databaseType, policy, schemaForFunctions),
          default:
            inputPositions.indexOf(index) >= defaultStart && defaultStart >= 0
              ? ("present" as const)
              : ("none" as const),
        }));
        const outputArguments = argumentsList.filter(({ mode }) => mode === "out" || mode === "inout");
        const kind = routineKind(row.routine_kind);
        const result =
          kind === "procedure"
            ? ({ kind: "command" } as const)
            : outputArguments.length > 0
              ? ({
                  kind: "table" as const,
                  columns: Object.fromEntries(
                    outputArguments.map((argument, position) => [
                      argument.name ?? `column${position + 1}`,
                      {
                        name: argument.name ?? `column${position + 1}`,
                        position,
                        databaseType: argument.databaseType,
                        typeIdentity: argument.typeIdentity,
                        tsType: argument.tsType,
                        nullable: true,
                        nullabilitySource: "unknown" as const,
                        default: "none" as const,
                        generated: "none" as const,
                        identity: "none" as const,
                        classification: "normal" as const,
                        insertable: false,
                        updatable: false,
                      },
                    ]),
                  ),
                } as const)
              : row.database_return_type === "record"
                ? ({ kind: "record", columns: {} } as const)
                : ({
                    kind: row.set_returning ? "set" : "scalar",
                    typeIdentity: row.database_return_type,
                    databaseType: row.database_return_type,
                    tsType: mapPostgresType(row.database_return_type, policy, schemaForFunctions),
                    nullable: !row.strict,
                  } as const);
        const family = polymorphicFamily([...row.argument_types, row.database_return_type]);
        const routine: RoutineSnapshot = {
          name: row.function_name,
          schema: row.schema_name,
          identity: row.routine_identity ?? `${name}(${row.argument_types.join(",")})`,
          kind,
          arguments: argumentsList,
          result,
          volatility: row.volatility === "i" ? "immutable" : row.volatility === "s" ? "stable" : "volatile",
          deterministic: row.volatility === "i" ? true : "unknown",
          dataAccess: "unknown",
          nullInput: row.strict === undefined ? "unknown" : row.strict ? "strict" : "called",
          ...(family === undefined ? {} : { polymorphicFamily: family }),
          extension: {
            version: "1",
            attributes: { parallelSafety: parallelSafety(row.parallel_safety) },
          },
        };
        const overloads = routines[name];
        if (overloads === undefined) routines[name] = [routine];
        else overloads.push(routine);
      }

      const namespaces = Object.fromEntries(
        [
          ...new Set([
            ...columnResult.rows.map(({ schema_name }) => schema_name),
            ...relationResult.rows.map(({ schema_name }) => schema_name),
            ...enumResult.rows.map(({ schema_name }) => schema_name),
            ...domainResult.rows.map(({ schema_name }) => schema_name),
            ...functionResult.rows.map(({ schema_name }) => schema_name),
          ]),
        ]
          .sort()
          .map((name) => [name, { name, kind: "schema" as const }]),
      );
      return defineSchemaSnapshotV2({
        formatVersion: 2,
        dialect: "postgres",
        dialectVersion: POSTGRES_DIALECT_VERSION,
        server: postgresServerEvidence(version, serverRow.extensions ?? [], {
          ...(serverRow.standard_conforming_strings === undefined
            ? {}
            : { standardConformingStrings: serverRow.standard_conforming_strings }),
          ...(serverRow.search_path === undefined ? {} : { searchPath: serverRow.search_path }),
          visibilityScope: "current-role",
        }),
        namespaces,
        types,
        relations,
        routines,
        extension: {
          version: "1",
          attributes: {
            evidenceScope: "current-role",
            partitionRelationships: "captured",
            routineParallelSafety: "captured",
          },
        },
      });
    });
  }
}

export async function introspectPostgres(
  input: SchemaInput,
  options: PostgresSchemaProviderOptions = {},
): Promise<SchemaSnapshotV2> {
  return new PostgresSchemaProvider(options).introspect(input);
}
