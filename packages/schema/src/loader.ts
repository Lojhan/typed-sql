import { readFile } from "node:fs/promises";
import type {
  ColumnSnapshot,
  DomainSnapshot,
  FunctionSnapshot,
  GeneratedSchemaMetadata,
  GeneratedSchemaSnapshot,
  SchemaSnapshot,
  TableSnapshot,
  TypePolicy,
} from "./model.js";
import { SCHEMA_FORMAT_VERSION } from "./model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseColumn(value: unknown, path: string): ColumnSnapshot {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.name !== "string") throw new TypeError(`${path}.name must be a string`);
  if (typeof value.databaseType !== "string") throw new TypeError(`${path}.databaseType must be a string`);
  if (typeof value.tsType !== "string") throw new TypeError(`${path}.tsType must be a string`);
  if (typeof value.nullable !== "boolean") throw new TypeError(`${path}.nullable must be a boolean`);
  if (value.array !== undefined && typeof value.array !== "boolean")
    throw new TypeError(`${path}.array must be a boolean`);
  if (value.defaultExpression !== undefined && typeof value.defaultExpression !== "string") {
    throw new TypeError(`${path}.defaultExpression must be a string`);
  }
  return {
    name: value.name,
    databaseType: value.databaseType,
    tsType: value.tsType,
    nullable: value.nullable,
    ...(value.array === undefined ? {} : { array: value.array }),
    ...(value.defaultExpression === undefined ? {} : { defaultExpression: value.defaultExpression }),
  };
}

function parseTable(value: unknown, path: string): TableSnapshot {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.name !== "string") throw new TypeError(`${path}.name must be a string`);
  if (value.schema !== undefined && typeof value.schema !== "string")
    throw new TypeError(`${path}.schema must be a string`);
  if (!isRecord(value.columns)) throw new TypeError(`${path}.columns must be an object`);
  const columns: Record<string, ColumnSnapshot> = {};
  for (const [name, column] of Object.entries(value.columns))
    columns[name] = parseColumn(column, `${path}.columns.${name}`);
  return { name: value.name, columns, ...(value.schema === undefined ? {} : { schema: value.schema }) };
}

function parseDomain(value: unknown, path: string): DomainSnapshot {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.name !== "string") throw new TypeError(`${path}.name must be a string`);
  if (typeof value.databaseType !== "string") throw new TypeError(`${path}.databaseType must be a string`);
  if (typeof value.tsType !== "string") throw new TypeError(`${path}.tsType must be a string`);
  if (typeof value.nullable !== "boolean") throw new TypeError(`${path}.nullable must be a boolean`);
  return { name: value.name, databaseType: value.databaseType, tsType: value.tsType, nullable: value.nullable };
}

function parseFunction(value: unknown, path: string): FunctionSnapshot {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.name !== "string") throw new TypeError(`${path}.name must be a string`);
  if (!Array.isArray(value.argumentTypes) || value.argumentTypes.some((item) => typeof item !== "string")) {
    throw new TypeError(`${path}.argumentTypes must be a string array`);
  }
  if (typeof value.returnType !== "string") throw new TypeError(`${path}.returnType must be a string`);
  if (typeof value.nullable !== "boolean") throw new TypeError(`${path}.nullable must be a boolean`);
  if (value.schema !== undefined && typeof value.schema !== "string")
    throw new TypeError(`${path}.schema must be a string`);
  if (value.databaseReturnType !== undefined && typeof value.databaseReturnType !== "string") {
    throw new TypeError(`${path}.databaseReturnType must be a string`);
  }
  if (value.setReturning !== undefined && typeof value.setReturning !== "boolean") {
    throw new TypeError(`${path}.setReturning must be a boolean`);
  }
  return {
    name: value.name,
    argumentTypes: value.argumentTypes as string[],
    returnType: value.returnType,
    nullable: value.nullable,
    ...(value.schema === undefined ? {} : { schema: value.schema }),
    ...(value.databaseReturnType === undefined ? {} : { databaseReturnType: value.databaseReturnType }),
    ...(value.setReturning === undefined ? {} : { setReturning: value.setReturning }),
  };
}

function parseStringArrays(value: unknown, path: string): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  const result: Record<string, readonly string[]> = {};
  for (const [name, labels] of Object.entries(value)) {
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
      throw new TypeError(`${path}.${name} must be a string array`);
    }
    result[name] = labels as string[];
  }
  return result;
}

function parseObjectMap<T>(
  value: unknown,
  path: string,
  parser: (item: unknown, itemPath: string) => T,
): Readonly<Record<string, T>> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  const result: Record<string, T> = {};
  for (const [name, item] of Object.entries(value)) result[name] = parser(item, `${path}.${name}`);
  return result;
}

export function parseSchemaSnapshot(value: unknown): SchemaSnapshot {
  if (!isRecord(value)) throw new TypeError("Schema snapshot must be an object");
  if (typeof value.dialect !== "string" || value.dialect.length === 0)
    throw new TypeError("schema.dialect must be a non-empty string");
  if (
    value.dialectVersion !== undefined &&
    (typeof value.dialectVersion !== "string" || value.dialectVersion.length === 0)
  )
    throw new TypeError("schema.dialectVersion must be a non-empty string");
  if (!isRecord(value.tables)) throw new TypeError("schema.tables must be an object");
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, table] of Object.entries(value.tables)) tables[name] = parseTable(table, `schema.tables.${name}`);
  const snapshot: SchemaSnapshot = {
    formatVersion:
      value.formatVersion === undefined
        ? SCHEMA_FORMAT_VERSION
        : value.formatVersion === SCHEMA_FORMAT_VERSION
          ? SCHEMA_FORMAT_VERSION
          : (() => {
              throw new TypeError(
                `Unsupported schema.formatVersion ${String(value.formatVersion)}; this release supports format ${SCHEMA_FORMAT_VERSION}`,
              );
            })(),
    dialect: value.dialect,
    ...(value.dialectVersion === undefined ? {} : { dialectVersion: value.dialectVersion }),
    tables,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(value.enums === undefined ? {} : { enums: parseStringArrays(value.enums, "schema.enums") }),
    ...(value.domains === undefined ? {} : { domains: parseObjectMap(value.domains, "schema.domains", parseDomain) }),
    ...(value.functions === undefined
      ? {}
      : { functions: parseObjectMap(value.functions, "schema.functions", parseFunction) }),
  };
  return snapshot;
}

/**
 * Migrates an unversioned pre-1.0 snapshot to the stable v1 format and validates
 * already-versioned input. Future format migrations are added here.
 */
export function migrateSchemaSnapshot(value: unknown): SchemaSnapshot {
  return parseSchemaSnapshot(value);
}

export async function loadSchemaSnapshot(path: string): Promise<SchemaSnapshot> {
  const source = await readFile(path, "utf8");
  return parseSchemaSnapshot(JSON.parse(source) as unknown);
}

function parseMetadata(value: unknown): GeneratedSchemaMetadata {
  if (!isRecord(value)) throw new TypeError("schema.metadata must be an object");
  if (typeof value.generatorVersion !== "string")
    throw new TypeError("schema.metadata.generatorVersion must be a string");
  if (typeof value.schemaHash !== "string") throw new TypeError("schema.metadata.schemaHash must be a string");
  if (typeof value.typePolicyHash !== "string") throw new TypeError("schema.metadata.typePolicyHash must be a string");
  return {
    generatorVersion: value.generatorVersion,
    schemaHash: value.schemaHash,
    typePolicyHash: value.typePolicyHash,
  };
}

export async function loadGeneratedSchemaSnapshot(path: string): Promise<GeneratedSchemaSnapshot> {
  const source = await readFile(path, "utf8");
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new TypeError("Generated schema snapshot must be an object");
  return { ...parseSchemaSnapshot(value), metadata: parseMetadata(value.metadata) };
}

export function parseTypePolicy(value: unknown): TypePolicy {
  if (!isRecord(value)) throw new TypeError("Type policy must be an object");
  return value;
}

export async function loadTypePolicy(path: string): Promise<TypePolicy> {
  return parseTypePolicy(JSON.parse(await readFile(path, "utf8")) as unknown);
}
