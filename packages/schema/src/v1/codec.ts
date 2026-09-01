import { parseDialectServerEvidence } from "@typed-sql/core";
import type { ColumnSnapshot, DomainSnapshot, FunctionSnapshot, SchemaSnapshotV1, TableSnapshot } from "./model.js";
import { LEGACY_SCHEMA_FORMAT_VERSION } from "./model.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseColumn(value: unknown, path: string): ColumnSnapshot {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
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
  if (!record(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.name !== "string") throw new TypeError(`${path}.name must be a string`);
  if (value.schema !== undefined && typeof value.schema !== "string")
    throw new TypeError(`${path}.schema must be a string`);
  if (!record(value.columns)) throw new TypeError(`${path}.columns must be an object`);
  const columns: Record<string, ColumnSnapshot> = {};
  for (const [name, column] of Object.entries(value.columns))
    columns[name] = parseColumn(column, `${path}.columns.${name}`);
  return { name: value.name, columns, ...(value.schema === undefined ? {} : { schema: value.schema }) };
}

function parseDomain(value: unknown, path: string): DomainSnapshot {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.name !== "string") throw new TypeError(`${path}.name must be a string`);
  if (typeof value.databaseType !== "string") throw new TypeError(`${path}.databaseType must be a string`);
  if (typeof value.tsType !== "string") throw new TypeError(`${path}.tsType must be a string`);
  if (typeof value.nullable !== "boolean") throw new TypeError(`${path}.nullable must be a boolean`);
  return { name: value.name, databaseType: value.databaseType, tsType: value.tsType, nullable: value.nullable };
}

function parseFunction(value: unknown, path: string): FunctionSnapshot {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
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
  if (
    value.volatility !== undefined &&
    value.volatility !== "immutable" &&
    value.volatility !== "stable" &&
    value.volatility !== "volatile"
  ) {
    throw new TypeError(`${path}.volatility must be immutable, stable, or volatile`);
  }
  return {
    name: value.name,
    argumentTypes: value.argumentTypes as string[],
    returnType: value.returnType,
    nullable: value.nullable,
    ...(value.schema === undefined ? {} : { schema: value.schema }),
    ...(value.databaseReturnType === undefined ? {} : { databaseReturnType: value.databaseReturnType }),
    ...(value.setReturning === undefined ? {} : { setReturning: value.setReturning }),
    ...(value.volatility === undefined ? {} : { volatility: value.volatility }),
  };
}

function parseStringArrays(value: unknown, path: string): Readonly<Record<string, readonly string[]>> {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
  const result: Record<string, readonly string[]> = {};
  for (const [name, labels] of Object.entries(value)) {
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
      throw new TypeError(`${path}.${name} must be a string array`);
    }
    result[name] = labels as string[];
  }
  return result;
}

function parseObjectMap<Value>(
  value: unknown,
  path: string,
  parser: (item: unknown, itemPath: string) => Value,
): Readonly<Record<string, Value>> {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
  const result: Record<string, Value> = {};
  for (const [name, item] of Object.entries(value)) result[name] = parser(item, `${path}.${name}`);
  return result;
}

export function parseSchemaSnapshotV1(value: unknown): SchemaSnapshotV1 {
  if (!record(value)) throw new TypeError("Schema snapshot must be an object");
  if (typeof value.dialect !== "string" || value.dialect.length === 0) {
    throw new TypeError("schema.dialect must be a non-empty string");
  }
  if (
    value.dialectVersion !== undefined &&
    (typeof value.dialectVersion !== "string" || value.dialectVersion.length === 0)
  ) {
    throw new TypeError("schema.dialectVersion must be a non-empty string");
  }
  if (!record(value.tables)) throw new TypeError("schema.tables must be an object");
  if (value.formatVersion !== undefined && value.formatVersion !== LEGACY_SCHEMA_FORMAT_VERSION) {
    throw new TypeError(`schema.formatVersion must be ${LEGACY_SCHEMA_FORMAT_VERSION}`);
  }
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, table] of Object.entries(value.tables)) tables[name] = parseTable(table, `schema.tables.${name}`);
  const snapshot: SchemaSnapshotV1 = {
    formatVersion: LEGACY_SCHEMA_FORMAT_VERSION,
    dialect: value.dialect,
    ...(value.dialectVersion === undefined ? {} : { dialectVersion: value.dialectVersion }),
    tables,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(value.server === undefined ? {} : { server: parseDialectServerEvidence(value.server) }),
    ...(value.enums === undefined ? {} : { enums: parseStringArrays(value.enums, "schema.enums") }),
    ...(value.domains === undefined ? {} : { domains: parseObjectMap(value.domains, "schema.domains", parseDomain) }),
    ...(value.functions === undefined
      ? {}
      : { functions: parseObjectMap(value.functions, "schema.functions", parseFunction) }),
  };
  if (snapshot.server !== undefined && snapshot.version !== undefined && snapshot.server.version !== snapshot.version) {
    throw new TypeError("schema.version must match schema.server.version during the format v1 compatibility bridge");
  }
  return snapshot;
}
