import type { PathLike } from "node:fs";
import { type SqliteQueryable, SqliteSchemaProvider } from "./provider.js";
import { createSqliteDatabase, type SqliteConnectionLike, type SqliteDatabase } from "./runtime.js";
import type { SqliteSchemaSnapshot } from "./snapshot.js";
import { defaultSqliteTypePolicy, type SqliteTypePolicy } from "./type-policy.js";

type SqliteInput = null | number | bigint | string | ArrayBufferView;

export interface NodeSqliteStatementLike {
  all(...values: readonly SqliteInput[]): Record<string, unknown>[];
  iterate(...values: readonly SqliteInput[]): IterableIterator<Record<string, unknown>>;
  setReadBigInts(enabled: boolean): void;
}

export interface NodeSqliteDatabaseLike {
  prepare(sql: string): NodeSqliteStatementLike;
  exec(sql: string): void;
  close(): void;
}

export interface NodeSqliteModuleLike {
  readonly DatabaseSync: new (path: PathLike, options?: Readonly<Record<string, unknown>>) => NodeSqliteDatabaseLike;
}

export interface NodeSqliteDatabaseOptions {
  readonly path: PathLike;
  readonly databaseOptions?: Readonly<Record<string, unknown>>;
  readonly typePolicy?: SqliteTypePolicy;
  readonly statementCacheSize?: number;
  /** Test or host-injected loader. Applications normally leave this unset. */
  readonly driverImporter?: () => Promise<NodeSqliteModuleLike>;
}

export interface NodeSqliteSchemaProviderOptions extends Omit<NodeSqliteDatabaseOptions, "path"> {
  readonly path?: PathLike;
  readonly database?: NodeSqliteDatabaseLike;
  readonly schemas?: readonly string[];
  readonly functions?: ConstructorParameters<typeof SqliteSchemaProvider>[0]["functions"];
}

function validateCacheSize(value: number | undefined): number {
  const size = value ?? 256;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new TypeError("node:sqlite statementCacheSize must be a positive safe integer");
  }
  return size;
}

function validateDatabaseOptions(options: Readonly<Record<string, unknown>> | undefined): void {
  if (options?.returnArrays !== undefined) {
    throw new TypeError("node:sqlite returnArrays is owned by @typed-sql/sqlite and cannot be configured");
  }
  if (options?.readBigInts !== undefined) {
    throw new TypeError("node:sqlite readBigInts is owned by @typed-sql/sqlite typePolicy and cannot be configured");
  }
}

function input(value: unknown): SqliteInput {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  if (typeof value === "boolean") return value ? 1n : 0n;
  throw new TypeError(`node:sqlite cannot bind ${value === undefined ? "undefined" : typeof value}`);
}

function statementCache(
  database: NodeSqliteDatabaseLike,
  policy: SqliteTypePolicy,
  maximum: number,
): (sql: string) => NodeSqliteStatementLike {
  const statements = new Map<string, NodeSqliteStatementLike>();
  return (sql) => {
    const cached = statements.get(sql);
    if (cached !== undefined) {
      statements.delete(sql);
      statements.set(sql, cached);
      return cached;
    }
    const prepared = database.prepare(sql);
    prepared.setReadBigInts(policy.integer === "bigint");
    statements.set(sql, prepared);
    if (statements.size > maximum) statements.delete(statements.keys().next().value!);
    return prepared;
  };
}

export function adaptNodeSqliteDatabase(
  database: NodeSqliteDatabaseLike,
  options: { readonly typePolicy?: SqliteTypePolicy; readonly statementCacheSize?: number } = {},
): SqliteConnectionLike {
  const prepared = statementCache(
    database,
    options.typePolicy ?? defaultSqliteTypePolicy,
    validateCacheSize(options.statementCacheSize),
  );
  return {
    all(sql, values = []) {
      return prepared(sql).all(...values.map(input));
    },
    exec(sql) {
      database.exec(sql);
    },
    iterate(sql, values = []) {
      return prepared(sql).iterate(...values.map(input));
    },
    close() {
      database.close();
    },
  };
}

export async function loadNodeSqlite(
  importer: () => Promise<NodeSqliteModuleLike> = () => import("node:sqlite"),
): Promise<NodeSqliteModuleLike> {
  try {
    return await importer();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_UNKNOWN_BUILTIN_MODULE") {
      throw new Error("@typed-sql/sqlite/node-sqlite requires a Node.js release that provides node:sqlite", {
        cause: error,
      });
    }
    throw error;
  }
}

async function open(options: NodeSqliteDatabaseOptions): Promise<NodeSqliteDatabaseLike> {
  validateDatabaseOptions(options.databaseOptions);
  validateCacheSize(options.statementCacheSize);
  const driver = await loadNodeSqlite(options.driverImporter);
  return new driver.DatabaseSync(options.path, {
    ...options.databaseOptions,
  });
}

export async function createNodeSqliteDatabase(options: NodeSqliteDatabaseOptions): Promise<SqliteDatabase> {
  const database = await open(options);
  return createSqliteDatabase({
    connection: adaptNodeSqliteDatabase(database, options),
    ownsConnection: true,
  });
}

export function nodeSqlite(options: NodeSqliteSchemaProviderOptions): { introspect(): Promise<SqliteSchemaSnapshot> } {
  return {
    async introspect(): Promise<SqliteSchemaSnapshot> {
      const ownsDatabase = options.database === undefined;
      if (ownsDatabase && options.path === undefined) {
        throw new TypeError("node:sqlite schema provider requires path or database");
      }
      const database = options.database ?? (await open({ ...options, path: options.path! }));
      const connection = adaptNodeSqliteDatabase(database, options);
      const client: SqliteQueryable = {
        async all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
          return (await connection.all(sql, values)) as readonly Row[];
        },
      };
      try {
        return await new SqliteSchemaProvider({
          client,
          ...(options.schemas === undefined ? {} : { schemas: options.schemas }),
          ...(options.functions === undefined ? {} : { functions: options.functions }),
          ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
        }).introspect();
      } finally {
        if (ownsDatabase) await connection.close?.();
      }
    },
  };
}
