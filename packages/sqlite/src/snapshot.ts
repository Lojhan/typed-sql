import {
  type ColumnSnapshot,
  parseSchemaSnapshot,
  type RelationSnapshot,
  type SchemaSnapshotV1,
  type SchemaSnapshotV2,
  type TableSnapshot,
} from "@typed-sql/schema";
import { isKnownStrictSqliteType } from "./type-policy.js";

export interface SqliteColumnSnapshot extends ColumnSnapshot {
  readonly generated?: "virtual" | "stored";
  readonly hidden?: boolean;
  readonly primaryKeyPosition?: number;
}

export interface SqliteIndexColumnSnapshot {
  readonly name?: string;
  readonly expression?: boolean;
  readonly descending?: boolean;
  readonly collation?: string;
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
  readonly kind: "shadow" | "table" | "view" | "virtual";
  readonly strict: boolean;
  readonly withoutRowid: boolean;
  readonly rowidAlias?: string;
  readonly columns: Readonly<Record<string, SqliteColumnSnapshot>>;
  readonly indexes: readonly SqliteIndexSnapshot[];
  readonly foreignKeys: readonly SqliteForeignKeySnapshot[];
}

type SqliteSnapshotViews = {
  readonly dialect: "sqlite";
  readonly tables: Readonly<Record<string, SqliteTableSnapshot>>;
};
export type SqliteSchemaSnapshotV1 = SchemaSnapshotV1 & SqliteSnapshotViews;
export type SqliteSchemaSnapshotV2 = SchemaSnapshotV2 & SqliteSnapshotViews;
export type SqliteSchemaSnapshot = SqliteSchemaSnapshotV1 | SqliteSchemaSnapshotV2;

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
    if (column.collation !== undefined && typeof column.collation !== "string") {
      throw new TypeError(`${path}.columns.${index}.collation must be a string`);
    }
    return {
      ...(column.name === undefined ? {} : { name: column.name }),
      ...(column.expression === undefined ? {} : { expression: column.expression }),
      ...(column.descending === undefined ? {} : { descending: column.descending }),
      ...(column.collation === undefined ? {} : { collation: column.collation }),
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

function assertSqliteV2Relation(relation: RelationSnapshot, path: string): void {
  const strict = relation.capabilities?.strict;
  const withoutRowid = relation.capabilities?.withoutRowid;
  if (strict !== undefined && typeof strict !== "boolean")
    throw new TypeError(`${path}.capabilities.strict must be a boolean`);
  if (withoutRowid !== undefined && typeof withoutRowid !== "boolean") {
    throw new TypeError(`${path}.capabilities.withoutRowid must be a boolean`);
  }
  const rowids = Object.values(relation.columns).filter(({ classification }) => classification === "rowid");
  if (rowids.length > 1) throw new TypeError(`${path}.columns may declare at most one rowid alias`);
  if (withoutRowid === true && rowids.length > 0)
    throw new TypeError(`${path} cannot combine WITHOUT ROWID and a rowid alias`);
  if (withoutRowid === true && !relation.constraints.some(({ kind }) => kind === "primary-key")) {
    throw new TypeError(`${path} requires primary-key evidence for a WITHOUT ROWID table`);
  }
  for (const [columnKey, column] of Object.entries(relation.columns)) {
    const columnPath = `${path}.columns.${columnKey}`;
    if (strict === true && !isKnownStrictSqliteType(column.databaseType)) {
      throw new TypeError(`${columnPath}.databaseType is not valid for an SQLite STRICT table`);
    }
    if (column.generated !== "none" && (column.insertable !== false || column.updatable !== false)) {
      throw new TypeError(`${columnPath} generated columns must not be writable`);
    }
    if (column.classification === "hidden" && (column.insertable !== false || column.updatable !== false)) {
      throw new TypeError(`${columnPath} hidden columns must not be writable`);
    }
    if (relation.kind === "view" && (column.insertable !== false || column.updatable !== false)) {
      throw new TypeError(`${columnPath} view columns require conservative write eligibility`);
    }
    if (
      column.classification === "rowid" &&
      (withoutRowid === true ||
        relation.kind !== "table" ||
        column.databaseType.trim().toUpperCase() !== "INTEGER" ||
        column.nullable ||
        column.identity !== "by-default")
    ) {
      throw new TypeError(`${columnPath} has invalid SQLite rowid-alias evidence`);
    }
  }
}

export function parseSqliteSchemaSnapshot(value: unknown): SqliteSchemaSnapshot {
  const base = parseSchemaSnapshot(value);
  if (base.dialect !== "sqlite") throw new TypeError(`@typed-sql/sqlite cannot use a ${base.dialect} schema snapshot`);
  if (base.formatVersion === 2) {
    const tables: Record<string, SqliteTableSnapshot> = {};
    for (const [key, relation] of Object.entries(base.relations)) {
      assertSqliteV2Relation(relation, `schema.relations.${key}`);
      const primary = relation.constraints.find(({ kind }) => kind === "primary-key");
      const primaryPositions = new Map(primary?.columns.map((column, index) => [column, index + 1]) ?? []);
      const indexes: SqliteIndexSnapshot[] = relation.indexes.map((index) => {
        const origin = index.extension?.attributes.origin;
        return {
          name: index.name,
          unique: index.unique,
          partial: index.predicate !== "none",
          origin:
            origin === "primary-key" || origin === "unique" || origin === "create"
              ? origin
              : index.unique
                ? "unique"
                : "create",
          columns: index.columns.map((column) => ({
            ...(column.column === undefined ? {} : { name: column.column }),
            ...(column.expressionHash === undefined ? {} : { expression: true }),
            ...(column.descending === undefined ? {} : { descending: column.descending }),
            ...(column.collation === undefined ? {} : { collation: column.collation }),
          })),
        };
      });
      const foreignKeys: SqliteForeignKeySnapshot[] = relation.constraints.flatMap((constraint) =>
        constraint.kind !== "foreign-key"
          ? []
          : [
              {
                columns: constraint.columns,
                referencedTable: constraint.referencedRelation,
                referencedColumns: constraint.referencedColumns,
                onUpdate: constraint.onUpdate.replaceAll("-", " ").toUpperCase(),
                onDelete: constraint.onDelete.replaceAll("-", " ").toUpperCase(),
              },
            ],
      );
      tables[key] = {
        ...(relation.schema === undefined ? { schema: "main" } : { schema: relation.schema }),
        name: relation.name,
        kind:
          relation.extension?.attributes.objectKind === "shadow"
            ? "shadow"
            : relation.kind === "virtual-table"
              ? "virtual"
              : relation.kind === "view"
                ? "view"
                : "table",
        strict: relation.capabilities?.strict === true,
        withoutRowid: relation.capabilities?.withoutRowid === true,
        ...(() => {
          const rowid = Object.values(relation.columns).find(({ classification }) => classification === "rowid");
          return rowid === undefined ? {} : { rowidAlias: rowid.name };
        })(),
        columns: Object.fromEntries(
          Object.entries(relation.columns).map(([columnKey, column]) => [
            columnKey,
            {
              name: column.name,
              databaseType: column.databaseType,
              tsType: column.tsType,
              nullable: column.nullable,
              ...(column.dimensions === undefined ? {} : { array: true }),
              ...(column.generated === "none" ? {} : { generated: column.generated }),
              ...(column.classification === "hidden" ? { hidden: true } : {}),
              ...(primaryPositions.has(column.name) ? { primaryKeyPosition: primaryPositions.get(column.name)! } : {}),
            },
          ]),
        ),
        indexes,
        foreignKeys,
      };
    }
    return { ...base, dialect: "sqlite", tables };
  }
  if (!record(value) || !record(value.tables)) throw new TypeError("schema.tables must be an object");
  const tables: Record<string, SqliteTableSnapshot> = {};
  for (const [key, table] of Object.entries(base.tables)) {
    const raw = value.tables[key];
    if (!record(raw)) throw new TypeError(`schema.tables.${key} must be an object`);
    const schema = raw.schema === undefined ? "main" : raw.schema;
    if (typeof schema !== "string") throw new TypeError(`schema.tables.${key}.schema must be a string`);
    const kind = raw.kind === undefined ? "table" : raw.kind;
    if (!(kind === "shadow" || kind === "table" || kind === "view" || kind === "virtual")) {
      throw new TypeError(`schema.tables.${key}.kind must be shadow, table, view, or virtual`);
    }
    const strict = raw.strict ?? false;
    const withoutRowid = raw.withoutRowid ?? false;
    const rowidAlias = raw.rowidAlias;
    if (typeof strict !== "boolean") throw new TypeError(`schema.tables.${key}.strict must be a boolean`);
    if (typeof withoutRowid !== "boolean") throw new TypeError(`schema.tables.${key}.withoutRowid must be a boolean`);
    if (rowidAlias !== undefined && typeof rowidAlias !== "string") {
      throw new TypeError(`schema.tables.${key}.rowidAlias must be a string`);
    }
    if (rowidAlias !== undefined && withoutRowid) {
      throw new TypeError(`schema.tables.${key} cannot combine WITHOUT ROWID and a rowid alias`);
    }
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
    if (rowidAlias !== undefined) {
      const column = Object.values(columns).find(({ name }) => name.toLowerCase() === rowidAlias.toLowerCase());
      if (
        column === undefined ||
        column.databaseType.trim().toUpperCase() !== "INTEGER" ||
        column.nullable ||
        column.primaryKeyPosition !== 1
      ) {
        throw new TypeError(`schema.tables.${key}.rowidAlias must name its non-null INTEGER PRIMARY KEY column`);
      }
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
      ...(rowidAlias === undefined ? {} : { rowidAlias }),
      columns,
      indexes: indexes.map((index, offset) => parseIndex(index, `schema.tables.${key}.indexes.${offset}`)),
      foreignKeys: foreignKeys.map((foreignKey, offset) =>
        parseForeignKey(foreignKey, `schema.tables.${key}.foreignKeys.${offset}`),
      ),
    };
  }
  return { ...base, dialect: "sqlite", tables };
}
