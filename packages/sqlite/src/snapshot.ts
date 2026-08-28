import { type ColumnSnapshot, parseSchemaSnapshot, type SchemaSnapshot, type TableSnapshot } from "@typed-sql/schema";

export interface SqliteColumnSnapshot extends ColumnSnapshot {
  readonly generated?: "virtual" | "stored";
  readonly hidden?: boolean;
  readonly primaryKeyPosition?: number;
}

export interface SqliteIndexColumnSnapshot {
  readonly name?: string;
  readonly expression?: boolean;
  readonly descending?: boolean;
}

export interface SqliteIndexSnapshot {
  readonly name: string;
  readonly unique: boolean;
  readonly partial: boolean;
  readonly origin: "create" | "unique" | "primary-key";
  readonly columns: readonly SqliteIndexColumnSnapshot[];
}

export interface SqliteForeignKeySnapshot {
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onUpdate: string;
  readonly onDelete: string;
}

export interface SqliteTableSnapshot extends TableSnapshot {
  readonly schema: string;
  readonly kind: "table" | "view" | "virtual";
  readonly strict: boolean;
  readonly withoutRowid: boolean;
  readonly columns: Readonly<Record<string, SqliteColumnSnapshot>>;
  readonly indexes: readonly SqliteIndexSnapshot[];
  readonly foreignKeys: readonly SqliteForeignKeySnapshot[];
}

export interface SqliteSchemaSnapshot extends SchemaSnapshot {
  readonly dialect: "sqlite";
  readonly tables: Readonly<Record<string, SqliteTableSnapshot>>;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${path} must be a string array`);
  }
  return value as string[];
}

function parseIndex(value: unknown, path: string): SqliteIndexSnapshot {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.name !== "string") throw new TypeError(`${path}.name must be a string`);
  if (typeof value.unique !== "boolean") throw new TypeError(`${path}.unique must be a boolean`);
  if (typeof value.partial !== "boolean") throw new TypeError(`${path}.partial must be a boolean`);
  if (!(value.origin === "create" || value.origin === "unique" || value.origin === "primary-key")) {
    throw new TypeError(`${path}.origin must be create, unique, or primary-key`);
  }
  if (!Array.isArray(value.columns)) throw new TypeError(`${path}.columns must be an array`);
  const columns = value.columns.map((column, index): SqliteIndexColumnSnapshot => {
    if (!record(column)) throw new TypeError(`${path}.columns.${index} must be an object`);
    if (column.name !== undefined && typeof column.name !== "string") {
      throw new TypeError(`${path}.columns.${index}.name must be a string`);
    }
    if (column.expression !== undefined && typeof column.expression !== "boolean") {
      throw new TypeError(`${path}.columns.${index}.expression must be a boolean`);
    }
    if (column.descending !== undefined && typeof column.descending !== "boolean") {
      throw new TypeError(`${path}.columns.${index}.descending must be a boolean`);
    }
    return {
      ...(column.name === undefined ? {} : { name: column.name }),
      ...(column.expression === undefined ? {} : { expression: column.expression }),
      ...(column.descending === undefined ? {} : { descending: column.descending }),
    };
  });
  return { name: value.name, unique: value.unique, partial: value.partial, origin: value.origin, columns };
}

function parseForeignKey(value: unknown, path: string): SqliteForeignKeySnapshot {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
  if (typeof value.referencedTable !== "string") throw new TypeError(`${path}.referencedTable must be a string`);
  if (typeof value.onUpdate !== "string") throw new TypeError(`${path}.onUpdate must be a string`);
  if (typeof value.onDelete !== "string") throw new TypeError(`${path}.onDelete must be a string`);
  return {
    columns: stringArray(value.columns, `${path}.columns`),
    referencedTable: value.referencedTable,
    referencedColumns: stringArray(value.referencedColumns, `${path}.referencedColumns`),
    onUpdate: value.onUpdate,
    onDelete: value.onDelete,
  };
}

export function parseSqliteSchemaSnapshot(value: unknown): SqliteSchemaSnapshot {
  const base = parseSchemaSnapshot(value);
  if (base.dialect !== "sqlite") throw new TypeError(`@typed-sql/sqlite cannot use a ${base.dialect} schema snapshot`);
  if (!record(value) || !record(value.tables)) throw new TypeError("schema.tables must be an object");
  const tables: Record<string, SqliteTableSnapshot> = {};
  for (const [key, table] of Object.entries(base.tables)) {
    const raw = value.tables[key];
    if (!record(raw)) throw new TypeError(`schema.tables.${key} must be an object`);
    const schema = raw.schema === undefined ? "main" : raw.schema;
    if (typeof schema !== "string") throw new TypeError(`schema.tables.${key}.schema must be a string`);
    const kind = raw.kind === undefined ? "table" : raw.kind;
    if (!(kind === "table" || kind === "view" || kind === "virtual")) {
      throw new TypeError(`schema.tables.${key}.kind must be table, view, or virtual`);
    }
    const strict = raw.strict ?? false;
    const withoutRowid = raw.withoutRowid ?? false;
    if (typeof strict !== "boolean") throw new TypeError(`schema.tables.${key}.strict must be a boolean`);
    if (typeof withoutRowid !== "boolean") throw new TypeError(`schema.tables.${key}.withoutRowid must be a boolean`);
    const columns: Record<string, SqliteColumnSnapshot> = {};
    for (const [columnKey, column] of Object.entries(table.columns)) {
      const rawColumn = record(raw.columns) ? raw.columns[columnKey] : undefined;
      if (rawColumn !== undefined && !record(rawColumn)) {
        throw new TypeError(`schema.tables.${key}.columns.${columnKey} must be an object`);
      }
      const generated = rawColumn?.generated;
      if (generated !== undefined && generated !== "virtual" && generated !== "stored") {
        throw new TypeError(`schema.tables.${key}.columns.${columnKey}.generated must be virtual or stored`);
      }
      const hidden = rawColumn?.hidden;
      const primaryKeyPosition = rawColumn?.primaryKeyPosition;
      if (hidden !== undefined && typeof hidden !== "boolean") {
        throw new TypeError(`schema.tables.${key}.columns.${columnKey}.hidden must be a boolean`);
      }
      if (
        primaryKeyPosition !== undefined &&
        (typeof primaryKeyPosition !== "number" || !Number.isSafeInteger(primaryKeyPosition) || primaryKeyPosition < 0)
      ) {
        throw new TypeError(`schema.tables.${key}.columns.${columnKey}.primaryKeyPosition must be non-negative`);
      }
      columns[columnKey] = {
        ...column,
        ...(generated === undefined ? {} : { generated }),
        ...(hidden === undefined ? {} : { hidden }),
        ...(primaryKeyPosition === undefined ? {} : { primaryKeyPosition: primaryKeyPosition as number }),
      };
    }
    const indexes = raw.indexes === undefined ? [] : raw.indexes;
    const foreignKeys = raw.foreignKeys === undefined ? [] : raw.foreignKeys;
    if (!Array.isArray(indexes)) throw new TypeError(`schema.tables.${key}.indexes must be an array`);
    if (!Array.isArray(foreignKeys)) throw new TypeError(`schema.tables.${key}.foreignKeys must be an array`);
    tables[key] = {
      ...table,
      schema,
      kind,
      strict,
      withoutRowid,
      columns,
      indexes: indexes.map((index, offset) => parseIndex(index, `schema.tables.${key}.indexes.${offset}`)),
      foreignKeys: foreignKeys.map((foreignKey, offset) =>
        parseForeignKey(foreignKey, `schema.tables.${key}.foreignKeys.${offset}`),
      ),
    };
  }
  return { ...base, dialect: "sqlite", tables };
}
