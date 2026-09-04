import type { PathLike } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DialectServerEvidence } from "@typed-sql/core";
import { matchesTypePolicyHash, type SchemaSnapshotV2 } from "@typed-sql/schema";
import { sqliteServerEvidence } from "./capabilities.js";
import { type SqliteQueryable, SqliteSchemaProvider } from "./provider.js";
import { createSqliteDatabase, type SqliteConnectionLike, type SqliteDatabase } from "./runtime.js";
import { parseSqliteSchemaSnapshot, type SqliteSchemaSnapshotV2 } from "./snapshot.js";
import { isNodeSqliteRuntimeSupported, NODE_SQLITE_RUNTIME_SUPPORT } from "./support.js";
import { defaultSqliteTypePolicy, type SqliteTypePolicy } from "./type-policy.js";

type SqliteInput = null | number | bigint | string | ArrayBufferView;

export interface NodeSqliteStatementLike {
  all(...values: readonly SqliteInput[]): Record<string, unknown>[];
  iterate?(...values: readonly SqliteInput[]): IterableIterator<Record<string, unknown>>;
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
  /** Generated snapshot whose server and type-policy evidence must match this connection. */
  readonly snapshot?: SchemaSnapshotV2;
  readonly statementCacheSize?: number;
  readonly preparedCardinalityVariantLimit?: number;
  /** Test or host-injected loader. Applications normally leave this unset. */
  readonly driverImporter?: () => Promise<NodeSqliteModuleLike>;
}

export type NodeSqliteCompatibilityReason = "compile-options" | "type-policy" | "version";

/** Fail-closed mismatch between compiler evidence and the SQLite library opened for execution. */
export class NodeSqliteCompatibilityError extends Error {
  readonly code = "SQLITE_RUNTIME_INCOMPATIBLE";
  readonly reason: NodeSqliteCompatibilityReason;

  constructor(reason: NodeSqliteCompatibilityReason, message: string) {
    super(message);
    this.name = "NodeSqliteCompatibilityError";
    this.reason = reason;
  }
}

export interface NodeSqliteSchemaProviderOptions extends Omit<NodeSqliteDatabaseOptions, "path" | "snapshot"> {
  readonly path?: PathLike;
  readonly database?: NodeSqliteDatabaseLike;
  readonly schemas?: readonly string[];
  readonly functions?: ConstructorParameters<typeof SqliteSchemaProvider>[0]["functions"];
  readonly routines?: ConstructorParameters<typeof SqliteSchemaProvider>[0]["routines"];
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

function input(value: unknown, policy: SqliteTypePolicy): SqliteInput {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  if (typeof value === "boolean") {
    return policy.integer === "bigint" ? (value ? 1n : 0n) : value ? 1 : 0;
  }
  throw new TypeError(`node:sqlite cannot bind ${value === undefined ? "undefined" : typeof value}`);
}

function output(value: unknown): null | number | bigint | string | Uint8Array {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`node:sqlite returned unsupported ${typeof value} storage value`);
}

function row(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, output(value)]));
}

interface NodeSqliteStatementCache {
  get(sql: string): NodeSqliteStatementLike;
  invalidate(): void;
}

function statementCache(
  database: NodeSqliteDatabaseLike,
  policy: SqliteTypePolicy,
  maximum: number,
): NodeSqliteStatementCache {
  const statements = new Map<string, NodeSqliteStatementLike>();
  return {
    get(sql) {
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
    },
    invalidate() {
      statements.clear();
    },
  };
}

function changesStatementIdentity(sql: string): boolean {
  const normalized = sql.replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))*/u, "").trimStart();
  return (
    /^(?:ALTER|ANALYZE|ATTACH|CREATE|DETACH|DROP|PRAGMA|REINDEX|VACUUM)\b/iu.test(normalized) ||
    /\bload_extension\s*\(/iu.test(normalized)
  );
}

function sortedEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function versionRow(rows: readonly Record<string, unknown>[]): string {
  const version = rows[0]?.version;
  if (typeof version !== "string") throw new TypeError("node:sqlite did not return sqlite_version() evidence");
  return version;
}

/** Reads canonical, non-secret capability evidence from an opened node:sqlite connection. */
export function readNodeSqliteServerEvidence(database: NodeSqliteDatabaseLike): DialectServerEvidence {
  const version = versionRow(database.prepare("SELECT sqlite_version() AS version").all());
  const compileOptions = database
    .prepare("PRAGMA compile_options")
    .all()
    .map(({ compile_options: option }, index) => {
      if (typeof option !== "string") {
        throw new TypeError(`node:sqlite PRAGMA compile_options row ${index} is invalid`);
      }
      return option;
    });
  return sqliteServerEvidence(version, compileOptions);
}

function validateSnapshotCompatibility(
  snapshotValue: SchemaSnapshotV2,
  actual: DialectServerEvidence,
  policy: SqliteTypePolicy | undefined,
): void {
  const snapshot = parseSqliteSchemaSnapshot(snapshotValue);
  if (snapshot.formatVersion !== 2) {
    throw new TypeError("node:sqlite runtime compatibility requires a schema format 2 snapshot");
  }
  if (snapshot.server.versionKey !== actual.versionKey) {
    throw new NodeSqliteCompatibilityError(
      "version",
      `SQLite snapshot version ${snapshot.server.versionKey} does not match connection version ${actual.versionKey}`,
    );
  }
  if (!sortedEqual(snapshot.server.features, actual.features)) {
    throw new NodeSqliteCompatibilityError(
      "compile-options",
      "SQLite snapshot compile options do not match the opened connection",
    );
  }
  if (snapshot.metadata !== undefined && !matchesTypePolicyHash(policy ?? {}, snapshot.metadata.typePolicyHash)) {
    throw new NodeSqliteCompatibilityError(
      "type-policy",
      "SQLite snapshot type-policy evidence does not match the Node adapter policy",
    );
  }
}

export function adaptNodeSqliteDatabase(
  database: NodeSqliteDatabaseLike,
  options: { readonly typePolicy?: SqliteTypePolicy; readonly statementCacheSize?: number } = {},
): SqliteConnectionLike {
  const policy = options.typePolicy ?? defaultSqliteTypePolicy;
  const prepared = statementCache(database, policy, validateCacheSize(options.statementCacheSize));
  return {
    all(sql, values = []) {
      const rows = prepared
        .get(sql)
        .all(...values.map((value) => input(value, policy)))
        .map(row);
      if (changesStatementIdentity(sql)) prepared.invalidate();
      return rows;
    },
    exec(sql) {
      database.exec(sql);
      if (changesStatementIdentity(sql)) prepared.invalidate();
    },
    iterate(sql, values = []) {
      const statement = prepared.get(sql);
      const inputs = values.map((value) => input(value, policy));
      const rows = statement.iterate?.(...inputs) ?? statement.all(...inputs)[Symbol.iterator]();
      if (changesStatementIdentity(sql)) prepared.invalidate();
      return (function* (): IterableIterator<Record<string, unknown>> {
        for (const value of rows) yield row(value);
      })();
    },
    close() {
      prepared.invalidate();
      database.close();
    },
  };
}

export async function loadNodeSqlite(
  importer: () => Promise<NodeSqliteModuleLike> = () => import("node:sqlite"),
): Promise<NodeSqliteModuleLike> {
  if (!isNodeSqliteRuntimeSupported(process.versions.node)) {
    throw new Error(
      `@typed-sql/sqlite/node-sqlite supports Node.js ${NODE_SQLITE_RUNTIME_SUPPORT.minimum}+ on line 22, plus lines 24 and 26`,
    );
  }
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
  return new driver.DatabaseSync(options.path instanceof URL ? fileURLToPath(options.path) : options.path, {
    ...options.databaseOptions,
  });
}

export async function createNodeSqliteDatabase(options: NodeSqliteDatabaseOptions): Promise<SqliteDatabase> {
  const database = await open(options);
  try {
    const server = readNodeSqliteServerEvidence(database);
    if (options.snapshot !== undefined) validateSnapshotCompatibility(options.snapshot, server, options.typePolicy);
    return createSqliteDatabase({
      connection: adaptNodeSqliteDatabase(database, options),
      ownsConnection: true,
      ...(options.preparedCardinalityVariantLimit === undefined
        ? {}
        : { preparedCardinalityVariantLimit: options.preparedCardinalityVariantLimit }),
    });
  } catch (error) {
    database.close();
    throw error;
  }
}

export function nodeSqlite(options: NodeSqliteSchemaProviderOptions): {
  introspect(): Promise<SqliteSchemaSnapshotV2>;
} {
  return {
    async introspect(): Promise<SqliteSchemaSnapshotV2> {
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
          ...(options.routines === undefined ? {} : { routines: options.routines }),
          ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
        }).introspect();
      } finally {
        if (ownsDatabase) await connection.close?.();
      }
    },
  };
}
