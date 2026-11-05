import {
  type BufferedDatabase,
  type BufferedOptions,
  createBufferedDatabase,
  type TransactionalDatabase,
} from "./index.js";
import { sqliteWireOptions } from "./sqlite-values.js";
import { transactionScope } from "./transaction-scope.js";

export type SqliteWasmBindValue = null | string | number | bigint | Uint8Array;

/** Structural OO1 contract; applications install and initialize the official driver. */
export interface SqliteWasmStatement {
  readonly pointer?: number | undefined;
  readonly columnCount: number;
  readonly parameterCount: number;
  bind(index: number, value: SqliteWasmBindValue): unknown;
  getColumnName(index: number): string;
  get(index: number, asType?: number): unknown;
  getBlob(index: number): Uint8Array | null;
  step(): boolean;
  finalize(): number | undefined;
}
export interface SqliteWasmConnection {
  readonly pointer?: number | undefined;
  prepare(sql: string): SqliteWasmStatement;
  isOpen(): boolean;
  close(): void;
  dbVfsName(schema?: string): string | undefined;
}
export interface SqliteWasmModule {
  readonly config: { readonly bigIntEnabled: boolean };
  readonly capi: {
    readonly SQLITE_INTEGER: number;
    readonly SQLITE_FLOAT: number;
    readonly SQLITE_TEXT: number;
    readonly SQLITE_BLOB: number;
    readonly SQLITE_NULL: number;
    sqlite3_column_type(statement: number, index: number): number;
    sqlite3_column_int64(statement: number, index: number): bigint;
    sqlite3_column_double(statement: number, index: number): number;
    sqlite3_sql(statement: number): string;
    sqlite3_prepare_v2(database: number, sql: string, bytes: number, statement: number, tail: number): number;
    sqlite3_finalize(statement: number): number;
    sqlite3_get_autocommit(database: number): number;
  };
  readonly wasm: {
    readonly pstack: { readonly pointer: number; alloc(bytes: number): number; restore(pointer: number): unknown };
    peekPtr(pointer: number): number;
    pokePtr(pointer: number, value: number): unknown;
  };
}
export interface SqliteWasmOptions extends BufferedOptions {
  /** Default false: closing the wrapper leaves the application's connection open. */
  readonly ownsConnection?: boolean;
}
export interface SqliteWasmQueryable {
  all<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
}
export interface SqliteWasmDatabase extends TransactionalDatabase {
  readonly evidence: {
    readonly libraryVersion: string;
    readonly compileOptions: readonly string[];
    readonly vfs: string | undefined;
  };
  /** Raw queryable for the SQLite grammar's existing PRAGMA schema provider. Shares the transaction lease. */
  readonly queryable: SqliteWasmQueryable;
  close(): Promise<void>;
}

const leases = new WeakMap<SqliteWasmConnection, object>();
const brokenConnections = new WeakSet<SqliteWasmConnection>();
const minInteger = -(1n << 63n);
const maxInteger = (1n << 63n) - 1n;
function values(input: readonly unknown[]): SqliteWasmBindValue[] {
  return input.map((value) => {
    if (value === null || typeof value === "string") return value;
    if (typeof value === "boolean") return value ? 1n : 0n;
    if (typeof value === "bigint") {
      if (value < minInteger || value > maxInteger)
        throw new RangeError("SQLite bigint is outside the signed 64-bit range");
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw new RangeError("SQLite Wasm requires finite numbers and safe integer numbers; use bigint for INTEGER");
      return value;
    }
    if (value instanceof Uint8Array) return value.slice();
    throw new TypeError("Unsupported SQLite Wasm bind value; serialize JSON through a compiled parameter plan");
  });
}

function nativePointer(resource: { readonly pointer?: number | undefined }): number {
  const pointer = resource.pointer;
  if (pointer === undefined || !Number.isSafeInteger(pointer) || pointer <= 0)
    throw new Error("SQLite Wasm resource has no live native pointer");
  return pointer;
}

/** Use SQLite itself to parse a tail; no duplicate SQL lexer and no silent first-statement truncation. */
function assertSingleStatement(
  module: SqliteWasmModule,
  connection: SqliteWasmConnection,
  statement: SqliteWasmStatement,
  text: string,
): void {
  const first = module.capi.sqlite3_sql(nativePointer(statement));
  if (!first || !text.startsWith(first)) throw new TypeError("SQLite did not preserve the prepared SQL source");
  const tail = text.slice(first.length);
  if (!tail.trim()) return;
  const stack = module.wasm.pstack.pointer;
  let extra = 0;
  let result = 0;
  try {
    const pointer = module.wasm.pstack.alloc(8);
    module.wasm.pokePtr(pointer, 0);
    result = module.capi.sqlite3_prepare_v2(nativePointer(connection), tail, -1, pointer, 0);
    extra = module.wasm.peekPtr(pointer);
  } finally {
    if (extra) module.capi.sqlite3_finalize(extra);
    module.wasm.pstack.restore(stack);
  }
  if (result !== 0 || extra !== 0) throw new TypeError("SQLite Wasm executes exactly one SQL statement per query");
}

function execute(
  module: SqliteWasmModule,
  connection: SqliteWasmConnection,
  text: string,
  input: readonly unknown[],
): readonly Record<string, unknown>[] {
  const bindings = values(input);
  if (text.includes("\0")) throw new TypeError("SQL source must not contain NUL");
  const statement = connection.prepare(text);
  const rows: Record<string, unknown>[] = [];
  try {
    const statementPointer = nativePointer(statement);
    assertSingleStatement(module, connection, statement, text);
    if (statement.parameterCount !== bindings.length)
      throw new TypeError("SQLite Wasm parameter count does not match the query");
    const names = Array.from({ length: statement.columnCount }, (_, index) => statement.getColumnName(index));
    if (new Set(names).size !== names.length) throw new TypeError("SQLite Wasm result columns must have unique names");
    bindings.forEach((value, index) => {
      statement.bind(index + 1, value);
    });
    while (statement.step()) {
      rows.push(
        Object.fromEntries(
          names.map((name, index) => {
            const type = module.capi.sqlite3_column_type(statementPointer, index);
            let value: unknown;
            if (type === module.capi.SQLITE_INTEGER) value = module.capi.sqlite3_column_int64(statementPointer, index);
            else if (type === module.capi.SQLITE_FLOAT)
              value = module.capi.sqlite3_column_double(statementPointer, index);
            else if (type === module.capi.SQLITE_TEXT) value = statement.get(index, module.capi.SQLITE_TEXT);
            else if (type === module.capi.SQLITE_BLOB) value = statement.getBlob(index)?.slice();
            else if (type === module.capi.SQLITE_NULL) value = null;
            else throw new TypeError("Unsupported SQLite storage class");
            return [name, value];
          }),
        ),
      );
    }
  } catch (error) {
    try {
      statement.finalize();
    } catch {
      /* Preserve the execution error. */
    }
    throw error;
  }
  const result = statement.finalize();
  if (result !== undefined && result !== 0) throw new Error(`SQLite statement finalization failed (${result})`);
  return rows;
}

/** Buffered OO1 execution in the caller's browser/worker/Node context, independent of the connection's VFS. */
export function createSqliteWasmDatabase(
  module: SqliteWasmModule,
  connection: SqliteWasmConnection,
  options: SqliteWasmOptions,
): SqliteWasmDatabase {
  if (!module.config.bigIntEnabled)
    throw new TypeError("SQLite Wasm requires native BigInt support for lossless INTEGER storage");
  if (options.profile.dialect !== "sqlite" || options.profile.integer !== "lossless")
    throw new TypeError("SQLite Wasm requires a SQLite lossless transport profile");
  if (
    options.profile.jsonWire !== "text" ||
    (options.profile.jsonInputWire !== undefined && options.profile.jsonInputWire !== "text")
  )
    throw new TypeError("SQLite Wasm requires text JSON wire formats");
  if (!connection.isOpen()) throw new Error("SQLite Wasm connection is closed");
  if (leases.has(connection) || module.capi.sqlite3_get_autocommit(nativePointer(connection)) === 0)
    throw new Error("SQLite Wasm requires an idle connection when creating a wrapper");
  const wire = sqliteWireOptions(options, false);
  let closed = false;
  const ensureOpen = (lease?: object) => {
    if (closed || !connection.isOpen()) throw new Error("SQLite Wasm database is closed");
    if (brokenConnections.has(connection))
      throw new Error("SQLite Wasm connection is unusable after transaction cleanup failed");
    if (leases.get(connection) !== lease)
      throw new Error("SQLite Wasm connection has an active transaction; use its callback scope");
  };
  const run = (text: string, input: readonly unknown[], lease?: object) => {
    ensureOpen(lease);
    return execute(module, connection, text, input);
  };
  const control = (text: string, lease: object) => run(text, [], lease);
  const evidence = Object.freeze({
    libraryVersion: String(run("SELECT sqlite_version() AS version", [])[0]?.version ?? ""),
    compileOptions: Object.freeze(
      run("PRAGMA compile_options", [])
        .map((row) => String(row.compile_options))
        .sort(),
    ),
    vfs: connection.dbVfsName(),
  });
  if (!/^\d+\.\d+\.\d+$/u.test(evidence.libraryVersion))
    throw new TypeError("SQLite Wasm did not report a normalized library version");
  const base = createBufferedDatabase(
    {
      async execute(text, input) {
        return run(text, input);
      },
      async batch(statements) {
        ensureOpen();
        const lease = {};
        leases.set(connection, lease);
        let begun = false;
        try {
          control("BEGIN", lease);
          begun = true;
          const rows = statements.map(({ text, values: input }) => run(text, input, lease));
          control("COMMIT", lease);
          begun = false;
          return rows;
        } catch (error) {
          if (begun) {
            try {
              control("ROLLBACK", lease);
            } catch {
              brokenConnections.add(connection);
            }
          }
          throw error;
        } finally {
          leases.delete(connection);
        }
      },
    },
    wire,
  );
  return Object.freeze({
    ...base,
    evidence,
    queryable: Object.freeze({
      async all<Row extends Record<string, unknown>>(
        text: string,
        input: readonly unknown[] = [],
      ): Promise<readonly Row[]> {
        return run(text, input) as readonly Row[];
      },
    }),
    async transaction<T>(callback: (database: BufferedDatabase) => Promise<T>): Promise<T> {
      ensureOpen();
      const lease = {};
      leases.set(connection, lease);
      const scope = transactionScope(
        {
          async execute(text, input) {
            return run(text, input, lease);
          },
        },
        wire,
      );
      let begun = false;
      try {
        control("BEGIN", lease);
        begun = true;
        const result = await callback(scope.database);
        await scope.finish();
        control("COMMIT", lease);
        begun = false;
        return result;
      } catch (error) {
        await scope.finish().catch(() => undefined);
        if (begun) {
          try {
            control("ROLLBACK", lease);
          } catch {
            brokenConnections.add(connection);
          }
        }
        throw error;
      } finally {
        leases.delete(connection);
      }
    },
    async close() {
      if (closed) return;
      if (leases.has(connection)) throw new Error("Cannot close SQLite Wasm during an active transaction");
      closed = true;
      if (options.ownsConnection && connection.isOpen()) connection.close();
    },
  });
}
