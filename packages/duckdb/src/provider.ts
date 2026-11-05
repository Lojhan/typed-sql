import {
  type ColumnSnapshotV2,
  defineSchemaSnapshotV2,
  fingerprintSchemaExpression,
  type NamespaceSnapshot,
  type RelationSnapshot,
  type RoutineSnapshot,
  type SchemaProvider,
  type TypeSnapshot,
} from "@typed-sql/schema";
import { type DuckDBType, formatDuckDBType, parseDuckDBType } from "./native-types.js";
import { type DuckDBSchemaSnapshot, duckDBRelationIdentity } from "./snapshot.js";
import { duckDBServerEvidence, duckDBVersionSupport } from "./support.js";
import {
  type DuckDBTypePolicy,
  defaultDuckDBTypePolicy,
  duckDBTypeIdentity,
  duckDBTypeScript,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";
export interface DuckDBQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
}
export interface DuckDBSchemaProviderOptions {
  readonly client: DuckDBQueryable;
  readonly typePolicy?: DuckDBTypePolicy;
  readonly catalogs?: readonly string[];
  readonly schemas?: readonly string[];
}
interface ColumnRow extends Record<string, unknown> {
  database_name: string;
  schema_name: string;
  table_name: string;
  column_name: string;
  column_index: number;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_generated?: boolean;
  generation_expression?: string | null;
}
interface RelationRow extends Record<string, unknown> {
  database_name: string;
  schema_name: string;
  name: string;
  kind: "table" | "view";
}
interface FunctionRow extends Record<string, unknown> {
  database_name: string;
  schema_name: string;
  function_name: string;
  function_type: string;
  return_type: string | null;
  parameters: readonly string[];
  parameter_types: readonly string[];
  varargs: string | null;
  has_side_effects: boolean | null;
  stability: string | null;
  macro_definition: string | null;
}
const settingNames = Object.freeze([
  "TimeZone",
  "Calendar",
  "schema",
  "search_path",
  "preserve_identifier_case",
  "default_collation",
  "default_null_order",
  "default_order",
  "old_implicit_casting",
  "lambda_syntax",
]);
/** Catalog reads are explicit, bounded to selected namespaces, and never install extensions. */
export class DuckDBSchemaProvider implements SchemaProvider<DuckDBSchemaSnapshot> {
  private readonly policy: DuckDBTypePolicy;
  constructor(private readonly options: DuckDBSchemaProviderOptions) {
    this.policy = validateDuckDBTypePolicy(options.typePolicy ?? defaultDuckDBTypePolicy);
  }
  async introspect(): Promise<DuckDBSchemaSnapshot> {
    const client = this.options.client;
    const versionRows = await client.all<{ version: string }>("SELECT version() AS version");
    const version = versionRows[0]?.version;
    if (typeof version !== "string") throw new TypeError("DuckDB version evidence is missing");
    if (duckDBVersionSupport(version) !== "supported")
      throw new TypeError(`DuckDB schema introspection needs a qualified engine, received ${version}`);
    const settings: Record<string, string | boolean | number> = {};
    const settingRows = await client.all<{ name: string; value: string }>(
      `SELECT name,value FROM duckdb_settings() WHERE name IN (${settingNames.map(() => "?").join(",")}) ORDER BY name`,
      settingNames,
    );
    for (const row of settingRows) if (settingNames.includes(row.name)) settings[row.name] = row.value;
    const current = await client.all<{ catalog: string; schema: string }>(
      "SELECT current_database() AS catalog,current_schema() AS schema",
    );
    if (current[0]) {
      settings.currentCatalog = current[0].catalog;
      settings.currentSchema = current[0].schema;
    }
    const extensionRows = await client.all<{ extension_name: string; extension_version: string; loaded: boolean }>(
      "SELECT extension_name,extension_version,loaded FROM duckdb_extensions() WHERE loaded ORDER BY extension_name",
    );
    const features = extensionRows.map((row) => `${row.extension_name}@${row.extension_version || "builtin"}`);
    const relations = await client.all<RelationRow>(
      "SELECT database_name,schema_name,table_name AS name,'table' AS kind FROM duckdb_tables() WHERE NOT internal UNION ALL SELECT database_name,schema_name,view_name AS name,'view' AS kind FROM duckdb_views() WHERE NOT internal ORDER BY database_name,schema_name,name",
    );
    const version2 = version.replace(/^v/u, "") === "2.0.0";
    const columns = await client.all<ColumnRow>(
      `SELECT database_name,schema_name,table_name,column_name,column_index,data_type,is_nullable,column_default${version2 ? ",is_generated,generation_expression" : ""} FROM duckdb_columns() WHERE NOT internal ORDER BY database_name,schema_name,table_name,column_index`,
    );
    const constraints = await client.all<Record<string, unknown>>(
      "SELECT database_name,schema_name,table_name,constraint_type,constraint_index,constraint_column_names,referenced_table,referenced_column_names,expression FROM duckdb_constraints() ORDER BY database_name,schema_name,table_name,constraint_index",
    );
    const indexRows = await client.all<Record<string, unknown>>(
      "SELECT database_name,schema_name,table_name,index_name,is_unique,is_primary,expressions FROM duckdb_indexes() ORDER BY database_name,schema_name,table_name,index_name",
    );
    const sequences = await client.all<Record<string, unknown>>(
      "SELECT database_name,schema_name,sequence_name,start_value,min_value,max_value,increment_by,cycle FROM duckdb_sequences() ORDER BY database_name,schema_name,sequence_name",
    );
    const functions = await client.all<FunctionRow>(
      "SELECT database_name,schema_name,function_name,function_type,return_type,parameters,parameter_types,varargs,has_side_effects,stability,macro_definition FROM duckdb_functions() ORDER BY database_name,schema_name,function_name,function_oid",
    );
    const types: Record<string, TypeSnapshot> = {},
      namespaces: Record<string, NamespaceSnapshot> = {},
      output: Record<string, RelationSnapshot> = {},
      routines: Record<string, RoutineSnapshot[]> = {};
    const allowed = (catalog: string, schema: string) =>
      (!this.options.catalogs || this.options.catalogs.includes(catalog)) &&
      (!this.options.schemas || this.options.schemas.includes(schema));
    const addType = (type: DuckDBType): string => {
      const identity = duckDBTypeIdentity(type);
      if (types[identity]) return identity;
      const base = {
        name: formatDuckDBType(type),
        identity,
        databaseType: formatDuckDBType(type),
        tsType: duckDBTypeScript(type, this.policy),
      };
      if (type.kind === "struct" || type.kind === "union")
        types[identity] = {
          ...base,
          kind: "composite",
          fields: type.fields.map((field) => ({
            name: field.name,
            typeIdentity: addType(field.type),
            databaseType: formatDuckDBType(field.type),
            tsType: duckDBTypeScript(field.type, this.policy),
            nullable: true,
          })),
          extension: { version: "1", attributes: { nativeKind: type.kind } },
        };
      else if (type.kind === "list" || type.kind === "array")
        types[identity] = {
          ...base,
          kind: "collection",
          elementTypeIdentity: addType(type.element),
          ...(type.kind === "array" ? { dimensions: [type.length] } : {}),
        };
      else if (type.kind === "enum") types[identity] = { ...base, kind: "enum", labels: type.values };
      else types[identity] = { ...base, kind: "scalar" };
      return identity;
    };
    for (const relation of relations) {
      if (!allowed(relation.database_name, relation.schema_name)) continue;
      const key = duckDBRelationIdentity(relation.database_name, relation.schema_name, relation.name);
      namespaces[relation.database_name] = { name: relation.database_name, kind: "catalog" };
      namespaces[duckDBRelationIdentity(relation.database_name, relation.schema_name, "")] = {
        name: relation.schema_name,
        kind: "schema",
        extension: { version: "1", attributes: { catalog: relation.database_name } },
      };
      const fields: Record<string, ColumnSnapshotV2> = {};
      for (const column of columns.filter(
        (item) =>
          item.database_name === relation.database_name &&
          item.schema_name === relation.schema_name &&
          item.table_name === relation.name,
      )) {
        const native = parseDuckDBType(column.data_type),
          generated = column.is_generated === true;
        fields[column.column_name] = {
          name: column.column_name,
          position: column.column_index - 1,
          databaseType: formatDuckDBType(native),
          typeIdentity: addType(native),
          tsType: duckDBTypeScript(native, this.policy),
          nullable: column.is_nullable,
          nullabilitySource: "declared",
          default: column.column_default === null ? "none" : "present",
          ...(column.column_default === null
            ? {}
            : { defaultExpressionHash: fingerprintSchemaExpression(column.column_default) }),
          generated: generated ? "virtual" : "none",
          ...(typeof column.generation_expression === "string"
            ? { generatedExpressionHash: fingerprintSchemaExpression(column.generation_expression) }
            : {}),
          identity: "none",
          classification: "normal",
          insertable: relation.kind === "table" && !generated,
          updatable: relation.kind === "table" && !generated,
        };
      }
      const structuralConstraints: RelationSnapshot["constraints"][number][] = [];
      for (const constraint of constraints.filter(
        (item) =>
          item.database_name === relation.database_name &&
          item.schema_name === relation.schema_name &&
          item.table_name === relation.name,
      )) {
        const common = {
          identity: `${key}:constraint:${constraint.constraint_index}`,
          columns: Array.isArray(constraint.constraint_column_names)
            ? constraint.constraint_column_names.filter((x): x is string => typeof x === "string")
            : [],
          partial: false as const,
          expressionBased: constraint.constraint_type === "CHECK",
          deferrable: false as const,
          initiallyDeferred: false as const,
        };
        if (constraint.constraint_type === "PRIMARY KEY")
          structuralConstraints.push({ ...common, kind: "primary-key", nullsDistinct: false });
        else if (constraint.constraint_type === "UNIQUE")
          structuralConstraints.push({ ...common, kind: "unique", nullsDistinct: true });
        else if (constraint.constraint_type === "CHECK")
          structuralConstraints.push({
            ...common,
            kind: "check",
            predicate: "present",
            ...(typeof constraint.expression === "string"
              ? { predicateHash: fingerprintSchemaExpression(constraint.expression) }
              : {}),
          });
        else if (constraint.constraint_type === "FOREIGN KEY" && typeof constraint.referenced_table === "string")
          structuralConstraints.push({
            ...common,
            kind: "foreign-key",
            referencedRelation: duckDBRelationIdentity(
              relation.database_name,
              relation.schema_name,
              constraint.referenced_table,
            ),
            referencedColumns: Array.isArray(constraint.referenced_column_names)
              ? constraint.referenced_column_names.filter((x): x is string => typeof x === "string")
              : [],
            match: "simple",
            onUpdate: "no-action",
            onDelete: "no-action",
          });
      }
      const indexes: RelationSnapshot["indexes"][number][] = indexRows
        .filter(
          (row) =>
            row.database_name === relation.database_name &&
            row.schema_name === relation.schema_name &&
            row.table_name === relation.name,
        )
        .map((row) => ({
          name: String(row.index_name),
          identity: `${key}:index:${row.index_name}`,
          unique: row.is_unique === true,
          method: "ART",
          columns: [{ expressionHash: fingerprintSchemaExpression(String(row.expressions)) }],
          predicate: "unknown",
          valid: true,
          extension: {
            version: "1",
            attributes: { nativeExpressions: String(row.expressions), primary: row.is_primary === true },
          },
        }));
      output[key] = {
        name: relation.name,
        schema: relation.schema_name,
        kind: relation.kind,
        columns: fields,
        constraints: structuralConstraints,
        indexes,
        extension: { version: "1", attributes: { catalog: relation.database_name } },
      };
    }
    for (const routine of functions) {
      if (
        !["scalar", "aggregate", "window"].includes(routine.function_type) ||
        routine.return_type === null ||
        !allowed(routine.database_name, routine.schema_name)
      )
        continue;
      let resultType: DuckDBType;
      try {
        resultType = parseDuckDBType(routine.return_type);
      } catch {
        continue;
      }
      const args: RoutineSnapshot["arguments"][number][] = [];
      let valid = true;
      for (let i = 0; i < routine.parameter_types.length; i++) {
        try {
          const native = parseDuckDBType(routine.parameter_types[i]!);
          args.push({
            ...(routine.parameters[i] ? { name: routine.parameters[i] } : {}),
            mode: "in",
            typeIdentity: addType(native),
            databaseType: formatDuckDBType(native),
            tsType: duckDBTypeScript(native, this.policy),
            default: "none",
          });
        } catch {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      const identity = duckDBRelationIdentity(routine.database_name, routine.schema_name, routine.function_name),
        list = routines[identity] ?? [];
      const kind =
        routine.function_type === "aggregate"
          ? "aggregate"
          : routine.function_type === "window"
            ? "window"
            : "function";
      list.push({
        name: routine.function_name,
        schema: routine.schema_name,
        identity: `${identity}(${args.map((x) => x.databaseType).join(",")})`,
        kind,
        arguments: args,
        result: {
          kind: "scalar",
          typeIdentity: addType(resultType),
          databaseType: formatDuckDBType(resultType),
          tsType: duckDBTypeScript(resultType, this.policy),
          nullable: true,
        },
        volatility:
          routine.has_side_effects === true ? "volatile" : routine.stability === "CONSISTENT" ? "immutable" : "unknown",
        deterministic: routine.has_side_effects === true ? false : "unknown",
        dataAccess: "unknown",
        nullInput: "unknown",
        extension: {
          version: "1",
          attributes: { catalog: routine.database_name, ...(routine.varargs ? { varargs: routine.varargs } : {}) },
        },
      });
      routines[identity] = list;
      addType(resultType);
    }
    return defineSchemaSnapshotV2({
      formatVersion: 2,
      dialect: "duckdb",
      dialectVersion: DUCKDB_DIALECT_VERSION,
      server: duckDBServerEvidence(version, features, settings),
      namespaces,
      types,
      relations: output,
      routines,
      extension: {
        version: "1",
        attributes: {
          sequences: sequences
            .filter((row) => allowed(String(row.database_name), String(row.schema_name)))
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  typeof value === "bigint"
                    ? String(value)
                    : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                      ? value
                      : null,
                ]),
              ),
            ),
          macros: functions
            .filter((row) => row.function_type === "macro" || row.function_type === "table_macro")
            .map((row) => ({
              catalog: row.database_name,
              schema: row.schema_name,
              name: row.function_name,
              kind: row.function_type,
              definitionHash:
                typeof row.macro_definition === "string"
                  ? fingerprintSchemaExpression(row.macro_definition)
                  : "unknown",
            })),
        },
      },
    }) as DuckDBSchemaSnapshot;
  }
}
