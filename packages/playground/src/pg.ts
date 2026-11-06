import { Buffer } from "node:buffer";
import { type Database, QueryCancelledError } from "@typed-sql/core";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";
import {
  createPostgresDatabase,
  createPostgresTypeParsers,
  type PostgresClientLike,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "@typed-sql/postgres/runtime";
import type { FieldDef, Pool, PoolClient } from "pg";
import type { PlaygroundQueryRequest, PlaygroundQueryResult, PlaygroundTarget } from "./contracts.js";

export interface PgPlaygroundOptions {
  readonly connectionString: string | (() => string | Promise<string>);
  readonly typePolicy?: PostgresTypePolicy;
  readonly schemas?: readonly string[];
  readonly decimal?: (value: string) => unknown;
}

/** Driver failures intentionally omit SQL, values, connection details and server messages. */
export class PlaygroundPgError extends Error {
  readonly code: string;
  readonly sqlState: string | undefined;
  readonly outcomeUnknown: boolean;

  constructor(code: string, message: string, options: { sqlState?: string; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "PlaygroundPgError";
    this.code = code;
    this.sqlState = options.sqlState;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export class PlaygroundPgCancellationError extends QueryCancelledError {
  readonly confirmed: boolean;
  readonly outcomeUnknown: boolean;
  constructor(reason: "signal" | "deadline", confirmed: boolean) {
    super(reason);
    this.confirmed = confirmed;
    this.outcomeUnknown = !confirmed;
  }
}

interface CursorResult {
  readonly fields: readonly FieldDef[];
  readonly command: string | null;
  readonly rowCount: number | null;
}

interface NativeCursor {
  read(count: number, callback: (error: Error | null, rows: unknown[][], result?: CursorResult) => void): void;
  close(): Promise<void>;
}

interface CursorConstructor {
  new (
    text: string,
    values: readonly unknown[],
    options: {
      readonly rowMode: "array";
      readonly types: ReturnType<typeof createPostgresTypeParsers>;
    },
  ): NativeCursor;
}

type RunOptions = Pick<
  PlaygroundQueryRequest,
  "readOnly" | "maxRows" | "timeoutMs" | "signal" | "maxResultBytes" | "pageSize"
>;
const driverPackage = "pg";
const cursorPackage = "pg-cursor";
const defaultMaximumBytes = 5 * 1024 * 1024;

function validateLimits(options: RunOptions): void {
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1 || options.maxRows > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Managed PostgreSQL maxRows must be an integer between 1 and Number.MAX_SAFE_INTEGER");
  }
  if (
    options.pageSize !== undefined &&
    (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000)
  ) {
    throw new RangeError("Managed PostgreSQL pageSize must be an integer between 1 and 1000");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000) {
    throw new RangeError("Managed PostgreSQL timeoutMs must be an integer between 1 and 120000");
  }
  const bytes = options.maxResultBytes ?? defaultMaximumBytes;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 100 * 1024 * 1024) {
    throw new RangeError("Managed PostgreSQL maxResultBytes must be between 1 and 104857600");
  }
}

/** PostgreSQL comments may nest; do not mistake a commented SET for a safe query. */
function firstKeyword(source: string): string {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < source.length) {
    if (/\s/u.test(source[index]!)) {
      index++;
      continue;
    }
    if (source.startsWith("--", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else index++;
      }
      if (depth !== 0) return "";
      continue;
    }
    break;
  }
  return /^[a-z]+/iu.exec(source.slice(index))?.[0]?.toUpperCase() ?? "";
}

function validateStatement(text: string, readOnly: boolean): void {
  const keyword = firstKeyword(text);
  const sessionCommands = new Set([
    "BEGIN",
    "START",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT",
    "RELEASE",
    "SET",
    "RESET",
    "DISCARD",
    "PREPARE",
    "DEALLOCATE",
    "COPY",
    "LISTEN",
    "UNLISTEN",
  ]);
  if (keyword === "" || sessionCommands.has(keyword)) {
    throw new PlaygroundPgError(
      "TSQL_PLAYGROUND_SQL_MODE",
      "Managed execution does not accept session, transaction, COPY or empty commands",
    );
  }
  if (readOnly && !new Set(["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN"]).has(keyword)) {
    throw new PlaygroundPgError("TSQL_PLAYGROUND_READ_ONLY", "This command requires the explicit write execution mode");
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" && /^[A-Z\d]{5}$/u.test(error.code) ? error.code : undefined;
}

function rowBytes(row: readonly unknown[]): number {
  return Buffer.byteLength(
    JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
  );
}

async function closeCursor(cursor: NativeCursor, client: PoolClient, disposed: () => boolean): Promise<void> {
  if (disposed()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onEnd: (() => void) | undefined;
  try {
    await Promise.race([
      cursor.close(),
      new Promise<void>((resolve) => {
        onEnd = resolve;
        client.once("end", onEnd);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PlaygroundPgError("TSQL_PLAYGROUND_CURSOR_CLOSE", "PostgreSQL cursor cleanup did not complete", {
                outcomeUnknown: true,
              }),
            ),
          2000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onEnd !== undefined) client.removeListener("end", onEnd);
  }
}

/** Explicit adapter: importing the main playground entry does not load either driver. */
export function createPgPlaygroundTarget(options: PgPlaygroundOptions): PlaygroundTarget {
  const policy = options.typePolicy ?? defaultPostgresTypePolicy;
  let resources:
    | Promise<{
        pool: Pool;
        control: Pool;
        Cursor: CursorConstructor;
        parsers: ReturnType<typeof createPostgresTypeParsers>;
      }>
    | undefined;
  let closed = false;
  const active = new Set<AbortController>();
  const load = () => {
    if (closed) throw new PlaygroundPgError("TSQL_PLAYGROUND_CLOSED", "The selected PostgreSQL target is closed");
    resources ??= (async () => {
      let driver: typeof import("pg");
      let Cursor: CursorConstructor;
      try {
        driver = (await import(driverPackage)) as typeof import("pg");
        const cursorModule = (await import(cursorPackage)) as { default?: unknown };
        if (typeof cursorModule.default !== "function") throw new TypeError("Invalid pg-cursor constructor");
        Cursor = cursorModule.default as CursorConstructor;
      } catch {
        throw new PlaygroundPgError(
          "TSQL_PLAYGROUND_DRIVER",
          "PostgreSQL execution requires application-owned pg and pg-cursor packages; install them with pnpm add pg pg-cursor",
        );
      }
      const connectionString =
        typeof options.connectionString === "function" ? await options.connectionString() : options.connectionString;
      const PoolConstructor = driver.Pool ?? driver.default.Pool;
      const poolOptions = { connectionString, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 };
      const pool = new PoolConstructor({ ...poolOptions, max: 4 });
      const control = new PoolConstructor({ ...poolOptions, max: 2 });
      // pg emits idle-client errors on the pool; pg already removes those clients.
      pool.on("error", () => undefined);
      control.on("error", () => undefined);
      return {
        pool,
        control,
        Cursor,
        parsers: createPostgresTypeParsers(policy, options.decimal, driver.types),
      };
    })();
    return resources;
  };

  async function fetch(
    client: PoolClient,
    text: string,
    values: readonly unknown[],
    limits: RunOptions,
    queryParsers?: ReturnType<typeof createPostgresTypeParsers>,
    disposed: () => boolean = () => false,
    onRows?: PlaygroundQueryRequest["onRows"],
  ): Promise<PlaygroundQueryResult> {
    validateStatement(text, limits.readOnly);
    const { Cursor, parsers } = await load();
    const cursor = new Cursor(text, values, { rowMode: "array", types: queryParsers ?? parsers });
    // pg-cursor uses PostgreSQL extended protocol: exactly one parsed statement, including when values is empty.
    const submit = client.query.bind(client) as unknown as (cursor: NativeCursor) => NativeCursor;
    submit(cursor);
    let metadata: CursorResult | undefined;
    const rows: unknown[][] = [];
    let bytes = 0;
    let delivered = 0;
    let truncated = false;
    try {
      while (!truncated) {
        const count = Math.min(1000, limits.pageSize ?? Math.min(limits.maxRows, 200));
        const batch = await new Promise<unknown[][]>((resolve, reject) => {
          cursor.read(count, (error, resultRows, result) => {
            if (error !== null) {
              reject(error);
              return;
            }
            metadata = result ?? metadata;
            resolve(resultRows);
          });
        });
        if (onRows) {
          // The consumer controls demand; PostgreSQL does not fetch the next batch until it resolves.
          const size = batch.reduce((total, row) => total + rowBytes(row), 0);
          if (size > (limits.maxResultBytes ?? defaultMaximumBytes))
            throw new PlaygroundPgError(
              "TSQL_PLAYGROUND_PAGE_LIMIT",
              "A result page exceeds the configured byte budget; reduce the page size",
            );
          const remaining = limits.maxRows - delivered;
          const selected = batch.slice(0, remaining);
          if (selected.length !== batch.length) truncated = true;
          delivered += selected.length;
          if (selected.length)
            await onRows({
              columns: (metadata?.fields ?? []).map((field) => ({
                name: field.name,
                databaseType: `oid:${field.dataTypeID}`,
              })),
              rows: selected,
              truncated,
            });
        } else
          for (const row of batch) {
            bytes += rowBytes(row);
            if (bytes > (limits.maxResultBytes ?? defaultMaximumBytes))
              throw new PlaygroundPgError(
                "TSQL_PLAYGROUND_RESULT_LIMIT",
                "Materialized application query exceeds the configured byte budget; use raw SQL paging or narrow the query",
              );
            if (rows.length >= limits.maxRows) {
              truncated = true;
              break;
            }
            rows.push(row);
          }
        if (batch.length < count) break;
      }
    } finally {
      await closeCursor(cursor, client, disposed);
    }
    return {
      columns: (metadata?.fields ?? []).map((field) => ({ name: field.name, databaseType: `oid:${field.dataTypeID}` })),
      rows,
      truncated,
      ...(metadata?.command ? { command: metadata.command } : {}),
      ...(metadata?.rowCount === null || metadata?.rowCount === undefined || metadata.command === "SELECT"
        ? {}
        : { affectedRows: metadata.rowCount }),
    };
  }

  async function lease(
    limits: RunOptions,
    streaming = false,
  ): Promise<{
    client: PoolClient;
    signal: AbortSignal;
    finish: (commit: boolean) => Promise<boolean>;
    assertActive: () => void;
    disposed: () => boolean;
    abort: () => void;
    cancellationReason: () => "signal" | "deadline" | undefined;
    pauseDeadline: () => void;
    resumeDeadline: () => void;
    run: <T>(operation: () => Promise<T>) => Promise<T>;
  }> {
    validateLimits(limits);
    if (limits.signal.aborted) throw new QueryCancelledError("signal");
    const { pool, control } = await load();
    const controller = new AbortController();
    active.add(controller);
    let deadlineExpired = false;
    let client: PoolClient | undefined;
    let fatalError: unknown;
    const onClientError = (error: Error) => {
      fatalError = error;
    };
    const onClientEnd = () => {
      fatalError ??= new Error("The PostgreSQL connection ended");
    };
    let cancelOperation: Promise<void> | undefined;
    let released = false;
    let executing = 0;
    let cancellationFallback: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    limits.signal.addEventListener("abort", abort, { once: true });
    const expire = () => {
      deadlineExpired = true;
      controller.abort();
    };
    let timer = setTimeout(expire, limits.timeoutMs);
    timer.unref();
    let pid: number | undefined;
    const cancel = () => {
      if (pid === undefined || released || client === undefined) return;
      const leased = client;
      const hadInFlightQuery = executing > 0;
      cancelOperation = (async () => {
        let acknowledged = false;
        try {
          const response = await control.query<{ cancelled: boolean }>("select pg_cancel_backend($1) as cancelled", [
            pid,
          ]);
          if (response.rows[0]?.cancelled !== true) throw new Error("Cancellation not confirmed");
          acknowledged = true;
        } catch {
          // No server cancellation acknowledgement: drop this connection rather than reuse it.
        } finally {
          if (!released && (!acknowledged || !hadInFlightQuery)) {
            released = true;
            leased.release(true);
          } else if (!released) {
            // Give the query error and explicit ROLLBACK a bounded opportunity to settle.
            cancellationFallback = setTimeout(() => {
              if (!released) {
                released = true;
                leased.release(true);
              }
            }, 1500);
            cancellationFallback.unref();
          }
        }
      })();
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (cancellationFallback !== undefined) clearTimeout(cancellationFallback);
      limits.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancel);
      active.delete(controller);
      client?.removeListener("error", onClientError);
      client?.removeListener("end", onClientEnd);
    };
    const assertActive = () => {
      if (controller.signal.aborted) throw new QueryCancelledError(deadlineExpired ? "deadline" : "signal");
    };
    try {
      client = await pool.connect();
      client.on("error", onClientError);
      client.on("end", onClientEnd);
      assertActive();
      const identity = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      pid = identity.rows[0]!.pid;
      await client.query(limits.readOnly ? "BEGIN READ ONLY" : "BEGIN READ WRITE");
      await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [
        streaming ? "0" : `${limits.timeoutMs}ms`,
      ]);
      // Establish a snapshot before author SQL so SET TRANSACTION cannot change read-only/isolation policy.
      await client.query("select 1");
      assertActive();
      const leased = client;
      return {
        client: leased,
        signal: controller.signal,
        pauseDeadline: () => clearTimeout(timer),
        resumeDeadline: () => {
          clearTimeout(timer);
          timer = setTimeout(expire, limits.timeoutMs);
          timer.unref();
        },
        assertActive,
        disposed: () => released || fatalError !== undefined,
        abort: () => controller.abort(),
        cancellationReason: () => (controller.signal.aborted ? (deadlineExpired ? "deadline" : "signal") : undefined),
        async run<T>(operation: () => Promise<T>): Promise<T> {
          executing++;
          try {
            return await operation();
          } finally {
            executing--;
          }
        },
        async finish(commit) {
          let reusable = false;
          try {
            if (commit) assertActive();
            if (cancelOperation !== undefined) await cancelOperation;
            if (!released) {
              await leased.query(commit ? "COMMIT" : "ROLLBACK");
              reusable = true;
            }
            return !commit && reusable;
          } finally {
            if (cancelOperation !== undefined) await cancelOperation;
            if (!released) {
              released = true;
              leased.release(!reusable);
            }
            cleanup();
          }
        },
      };
    } catch (error) {
      if (cancelOperation !== undefined) await cancelOperation;
      if (client !== undefined && !released) {
        released = true;
        client.release(true);
      }
      cleanup();
      throw error;
    }
  }

  function normalize(error: unknown, readOnly: boolean): Error {
    if (error instanceof PlaygroundPgCancellationError || error instanceof PlaygroundPgError) return error;
    if (error instanceof QueryCancelledError) return new PlaygroundPgCancellationError(error.reason, false);
    const state = sqlState(error);
    if (state === "57014") return new PlaygroundPgCancellationError("deadline", false);
    return new PlaygroundPgError(
      state === "25006" ? "TSQL_PLAYGROUND_READ_ONLY" : "TSQL_PLAYGROUND_PG",
      state === "25006"
        ? "The database rejected a write in read-only mode"
        : "PostgreSQL execution failed; inspect the SQL and target permissions",
      {
        ...(state === undefined ? {} : { sqlState: state }),
        outcomeUnknown:
          !readOnly && (state === undefined || state.startsWith("08") || ["57P01", "57P02", "57P03"].includes(state)),
      },
    );
  }

  async function query(
    request: PlaygroundQueryRequest,
    parsers?: ReturnType<typeof createPostgresTypeParsers>,
  ): Promise<PlaygroundQueryResult> {
    validateLimits(request);
    let session: Awaited<ReturnType<typeof lease>> | undefined;
    let finished = false;
    let consumerError: unknown;
    try {
      validateStatement(request.text, request.readOnly);
      session = await lease(request, request.onRows !== undefined);
      const result = await session.run(() =>
        fetch(
          session!.client,
          request.text,
          request.values,
          request,
          parsers,
          session!.disposed,
          request.onRows
            ? async (batch) => {
                session!.pauseDeadline();
                let aborted: (() => void) | undefined;
                const idleTimer = setTimeout(() => session!.abort(), request.cursorIdleMs ?? 30_000);
                idleTimer.unref();
                try {
                  await Promise.race([
                    Promise.resolve().then(() => request.onRows!(batch)),
                    new Promise<never>((_resolve, reject) => {
                      aborted = () => reject(new QueryCancelledError(session!.cancellationReason() ?? "signal"));
                      session!.signal.addEventListener("abort", aborted, { once: true });
                      if (session!.signal.aborted) aborted();
                    }),
                  ]);
                } catch (error) {
                  consumerError = error;
                  throw error;
                } finally {
                  clearTimeout(idleTimer);
                  if (aborted) session!.signal.removeEventListener("abort", aborted);
                  session!.resumeDeadline();
                }
              }
            : undefined,
        ),
      );
      session.assertActive();
      finished = true;
      await session.finish(true);
      return result;
    } catch (error) {
      const rolledBack = session !== undefined && !finished ? await session.finish(false).catch(() => false) : false;
      const reason =
        session?.cancellationReason() ??
        (request.signal.aborted ? "signal" : sqlState(error) === "57014" ? "deadline" : undefined);
      if (reason !== undefined || error instanceof QueryCancelledError) {
        throw new PlaygroundPgCancellationError(
          reason ?? (error as QueryCancelledError).reason,
          session === undefined || rolledBack,
        );
      }
      if (consumerError !== undefined) throw consumerError;
      throw normalize(error, request.readOnly);
    }
  }

  return {
    rowStreaming: true,
    async identity() {
      const { pool } = await load();
      try {
        const result = await pool.query<{ database: string; version: string; read_only: string }>(
          "select current_database() as database, current_setting('server_version') as version, current_setting('default_transaction_read_only') as read_only",
        );
        const row = result.rows[0]!;
        return {
          database: row.database,
          server: `PostgreSQL ${row.version}`,
          adapter: "pg",
          readOnly: row.read_only === "on",
        };
      } catch (error) {
        throw normalize(error, true);
      }
    },
    query,
    async database(limits): Promise<Database> {
      validateLimits(limits);
      const { parsers } = await load();
      const toObjectRows = (result: PlaygroundQueryResult, committed = false): PostgresQueryResult => {
        if (result.truncated)
          throw new PlaygroundPgError(
            "TSQL_PLAYGROUND_RESULT_LIMIT",
            committed
              ? "Statement committed, but its returned rows exceeded the managed result limit; inspect effects before running again"
              : "Application query exceeded the managed result limit; narrow the query before running again",
          );
        return {
          rows: result.rows.map((row) => Object.fromEntries(result.columns.map((field, i) => [field.name, row[i]]))),
        };
      };
      const pool: PostgresPoolLike = {
        rawJsonParsers: true,
        executionCapabilities: { cancellation: true, deadlines: true },
        async query(config) {
          if (typeof config === "string")
            throw new PlaygroundPgError("TSQL_PLAYGROUND_SQL_MODE", "Unscoped transaction commands are unsupported");
          return toObjectRows(
            await query({ ...limits, text: config.text, values: config.values ?? [] }, config.types ?? parsers),
            !limits.readOnly,
          );
        },
        async connect(): Promise<PostgresClientLike> {
          const session = await lease(limits);
          let ended = false;
          let begun = false;
          let pending = Promise.resolve();
          return {
            query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
              const operation = async (): Promise<PostgresQueryResult> => {
                if (ended)
                  throw new PlaygroundPgError("TSQL_PLAYGROUND_TRANSACTION", "The managed transaction has ended");
                session.assertActive();
                if (typeof config === "string") {
                  if (config === "BEGIN" && !begun) {
                    begun = true;
                    return { rows: [] };
                  }
                  if (config === "COMMIT" || config === "ROLLBACK") {
                    ended = true;
                    await session.finish(config === "COMMIT");
                    return { rows: [] };
                  }
                  if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) [a-z_\d]+$/iu.test(config)) {
                    await session.client.query(config);
                    return { rows: [] };
                  }
                  throw new PlaygroundPgError("TSQL_PLAYGROUND_TRANSACTION", "Unsupported managed transaction control");
                }
                const result = await session.run(() =>
                  fetch(
                    session.client,
                    config.text,
                    config.values ?? [],
                    limits,
                    config.types ?? parsers,
                    session.disposed,
                  ),
                );
                session.assertActive();
                if (!begun) {
                  ended = true;
                  await session.finish(true);
                }
                return toObjectRows(result, !begun && !limits.readOnly);
              };
              const running = pending.then(operation).catch((error) => {
                throw normalize(error, limits.readOnly);
              });
              pending = running.then(
                () => undefined,
                () => undefined,
              );
              return running;
            },
            release(error) {
              if (error) session.abort();
              if (!ended) {
                ended = true;
                void pending.then(() => session.finish(false)).catch(() => undefined);
              }
            },
          };
        },
        async end() {},
      };
      const database = createPostgresDatabase({
        pool,
        typePolicy: policy,
        ...(options.decimal === undefined ? {} : { decimal: options.decimal }),
      });
      // Per-call controls can reject before native cleanup confirms rollback.
      return new Proxy(database, {
        get(object, property) {
          const value: unknown = Reflect.get(object, property, object);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const result: unknown = Reflect.apply(value, object, args);
            if (!(result instanceof Promise)) return result;
            return result.catch((error: unknown) => {
              if (error instanceof QueryCancelledError && !(error instanceof PlaygroundPgCancellationError)) {
                throw new PlaygroundPgCancellationError(error.reason, false);
              }
              throw error;
            });
          };
        },
      });
    },
    async snapshot() {
      const { pool } = await load();
      return pg({ client: pool, schemas: options.schemas ?? ["public"], typePolicy: policy }).introspect();
    },
    async close() {
      if (closed) return;
      for (const controller of active) controller.abort();
      // Capture the loading promise before closing the factory to avoid opening new resources.
      const pending = resources;
      closed = true;
      if (pending !== undefined) {
        const result = await pending.catch(() => undefined);
        if (result === undefined) return;
        const { pool, control } = result;
        await pool.end();
        await control.end();
      }
    },
  };
}
