import type { FunctionSnapshot, SchemaInput, SchemaProvider } from "@typed-sql/schema";
import type {
  SqliteForeignKeySnapshot,
  SqliteIndexSnapshot,
  SqliteSchemaSnapshot,
  SqliteTableSnapshot,
} from "./snapshot.js";
import { defaultSqliteTypePolicy, mapSqliteType, type SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface SqliteQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): MaybePromise<readonly Row[]>;
}

export interface SqliteSchemaProviderOptions {
  readonly client: SqliteQueryable;
  readonly schemas?: readonly string[];
  readonly functions?: Readonly<Record<string, FunctionSnapshot>>;
  readonly typePolicy?: SqliteTypePolicy;
}

interface TableListRow extends Record<string, unknown> {
  readonly schema: string;
  readonly name: string;
  readonly type: "table" | "view" | "shadow";
  readonly wr: number | bigint;
  readonly strict: number | bigint;
}

interface TableXinfoRow extends Record<string, unknown> {
  readonly name: string;
  readonly type: string;
  readonly notnull: number | bigint;
  readonly dflt_value: string | null;
  readonly pk: number | bigint;
  readonly hidden: number | bigint;
}

interface IndexListRow extends Record<string, unknown> {
  readonly name: string;
  readonly unique: number | bigint;
  readonly origin: "c" | "u" | "pk";
  readonly partial: number | bigint;
}

interface IndexXinfoRow extends Record<string, unknown> {
  readonly name: string | null;
  readonly desc: number | bigint;
  readonly key: number | bigint;
  readonly cid: number | bigint;
}

interface ForeignKeyRow extends Record<string, unknown> {
  readonly id: number | bigint;
  readonly seq: number | bigint;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
}

interface VersionRow extends Record<string, unknown> {
  readonly version: string;
}

function identifier(value: string): string {
  if (value.length === 0 || value.includes("\0"))
    throw new TypeError("SQLite identifiers must be non-empty and omit NUL");
  return `"${value.replaceAll('"', '""')}"`;
}

function integer(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

async function all<Row extends Record<string, unknown>>(
  client: SqliteQueryable,
  sql: string,
  values?: readonly unknown[],
): Promise<readonly Row[]> {
  return await client.all<Row>(sql, values);
}

function indexOrigin(origin: IndexListRow["origin"]): SqliteIndexSnapshot["origin"] {
  return origin === "pk" ? "primary-key" : origin === "u" ? "unique" : "create";
}

async function indexes(
  client: SqliteQueryable,
  schema: string,
  table: string,
): Promise<readonly SqliteIndexSnapshot[]> {
  const rows = await all<IndexListRow>(client, `PRAGMA ${identifier(schema)}.index_list(${identifier(table)})`);
  return await Promise.all(
    rows.map(async (row) => {
      const columns = await all<IndexXinfoRow>(
        client,
        `PRAGMA ${identifier(schema)}.index_xinfo(${identifier(row.name)})`,
      );
      return {
        name: row.name,
        unique: integer(row.unique) === 1,
        partial: integer(row.partial) === 1,
        origin: indexOrigin(row.origin),
        columns: columns
          .filter(({ key }) => integer(key) === 1)
          .map((column) => ({
            ...(column.name === null ? {} : { name: column.name }),
            ...(integer(column.cid) < 0 ? { expression: true } : {}),
            ...(integer(column.desc) === 1 ? { descending: true } : {}),
          })),
      };
    }),
  );
}

async function foreignKeys(
  client: SqliteQueryable,
  schema: string,
  table: string,
): Promise<readonly SqliteForeignKeySnapshot[]> {
  const rows = await all<ForeignKeyRow>(client, `PRAGMA ${identifier(schema)}.foreign_key_list(${identifier(table)})`);
  const groups = new Map<number | bigint, ForeignKeyRow[]>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (group === undefined) groups.set(row.id, [row]);
    else group.push(row);
  }
  return [...groups.values()].map((group) => {
    group.sort((left, right) => integer(left.seq) - integer(right.seq));
    const first = group[0]!;
    return {
      columns: group.map((row) => row.from),
      referencedTable: first.table,
      referencedColumns: group.flatMap((row) => (row.to === null ? [] : [row.to])),
      onUpdate: first.on_update,
      onDelete: first.on_delete,
    };
  });
}

export class SqliteSchemaProvider implements SchemaProvider {
  readonly #client: SqliteQueryable;
  readonly #schemas: readonly string[] | undefined;
  readonly #functions: Readonly<Record<string, FunctionSnapshot>> | undefined;
  readonly #policy: SqliteTypePolicy;

  constructor(options: SqliteSchemaProviderOptions) {
    this.#client = options.client;
    this.#schemas = options.schemas;
    this.#functions = options.functions;
    this.#policy = options.typePolicy ?? defaultSqliteTypePolicy;
  }

  async introspect(_input: SchemaInput = {}): Promise<SqliteSchemaSnapshot> {
    const version = (await all<VersionRow>(this.#client, "SELECT sqlite_version() AS version"))[0]?.version;
    const listed = await all<TableListRow>(this.#client, "PRAGMA table_list");
    const requested = this.#schemas === undefined ? new Set(["main"]) : new Set(this.#schemas);
    if (requested.size === 0) throw new TypeError("SQLite schema introspection requires at least one schema");
    const selected = listed.filter(
      (row) => requested.has(row.schema) && !row.name.startsWith("sqlite_") && row.type !== "shadow",
    );
    const tables: Record<string, SqliteTableSnapshot> = {};
    for (const row of selected) {
      const columns = await all<TableXinfoRow>(
        this.#client,
        `PRAGMA ${identifier(row.schema)}.table_xinfo(${identifier(row.name)})`,
      );
      const key = requested.size === 1 && row.schema === "main" ? row.name : `${row.schema}.${row.name}`;
      const strict = integer(row.strict) === 1;
      tables[key] = {
        schema: row.schema,
        name: row.name,
        kind: row.type === "view" ? "view" : columns.some(({ hidden }) => integer(hidden) === 1) ? "virtual" : "table",
        strict,
        withoutRowid: integer(row.wr) === 1,
        columns: Object.fromEntries(
          columns.map((column) => [
            column.name,
            {
              name: column.name,
              databaseType: column.type,
              tsType: mapSqliteType(column.type, this.#policy, { strict }),
              nullable: integer(column.notnull) !== 1 && integer(column.pk) === 0,
              ...(column.dflt_value === null ? {} : { defaultExpression: column.dflt_value }),
              ...(integer(column.hidden) === 1 ? { hidden: true } : {}),
              ...(integer(column.hidden) === 2 ? { generated: "virtual" as const } : {}),
              ...(integer(column.hidden) === 3 ? { generated: "stored" as const } : {}),
              ...(integer(column.pk) === 0 ? {} : { primaryKeyPosition: integer(column.pk) }),
            },
          ]),
        ),
        indexes: await indexes(this.#client, row.schema, row.name),
        foreignKeys: await foreignKeys(this.#client, row.schema, row.name),
      };
    }
    return {
      formatVersion: 1,
      dialect: "sqlite",
      dialectVersion: SQLITE_DIALECT_VERSION,
      ...(version === undefined ? {} : { version }),
      tables,
      ...(this.#functions === undefined || Object.keys(this.#functions).length === 0
        ? {}
        : { functions: this.#functions }),
    };
  }
}

export async function introspectSqlite(options: SqliteSchemaProviderOptions): Promise<SqliteSchemaSnapshot> {
  return new SqliteSchemaProvider(options).introspect();
}
