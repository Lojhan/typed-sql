import type {
  LiveQueryVerificationEvidence,
  LiveQueryVerificationField,
  LiveQueryVerificationRequest,
  LiveQueryVerifier,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { assertSqlServerRuntimeEvidence } from "./capabilities.js";
import { parseSqlServerNativeType, requireSqlServerNativeType } from "./native-types.js";
import { parseStatement, tokenize } from "./parser/index.js";
import { readSqlServerServerEvidence, type SqlServerQueryable } from "./provider.js";
import { defaultSqlServerTypePolicy, type SqlServerTypePolicy, validateSqlServerTypePolicy } from "./type-policy.js";

/** Each acquisition must exclusively own one physical session until release/discard. */
/** Service SQL uses positional ? markers; the client binds values without interpolation. */
export interface SqlServerServiceSession extends SqlServerQueryable {
  release(): void | Promise<void>;
  /** Destroy/quarantine the session. It must never return to the reusable pool. */
  discard(): void | Promise<void>;
}
export interface SqlServerServicePool {
  acquire(): Promise<SqlServerServiceSession>;
  close?(): void | Promise<void>;
}
export interface SqlServerLiveVerifierOptions {
  readonly pool: SqlServerServicePool;
  readonly ownsPool?: boolean;
  readonly typePolicy?: SqlServerTypePolicy;
}
export const sqlServerVerificationQueries = Object.freeze({
  parameters: "EXEC sys.sp_describe_undeclared_parameters @tsql = ?",
  columns:
    "SELECT is_hidden,column_ordinal,name,system_type_name,is_nullable,collation_name,error_number,error_type FROM sys.dm_exec_describe_first_result_set(?, ?, 0) ORDER BY column_ordinal",
});
const active = new WeakSet<object>(),
  poisoned = new WeakSet<object>();
/** @internal Shared lifecycle for native describe and session-scoped SHOWPLAN. */
export class SqlServerServiceScope {
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly pool: SqlServerServicePool,
    private readonly ownsPool = false,
  ) {
    if (typeof pool?.acquire !== "function" || (ownsPool && typeof pool.close !== "function"))
      throw new TypeError("SQL Server service pool requires acquisition and owned cleanup");
  }
  run<T>(operation: (session: SqlServerServiceSession, quarantine: () => void) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("SQL Server verification service is closed"));
    const result = (async () => {
      let session: SqlServerServiceSession | undefined,
        discard = false,
        registered = false;
      try {
        session = await this.pool.acquire();
        if (active.has(session) || poisoned.has(session))
          throw new Error("SQL Server service requires an exclusive usable session");
        active.add(session);
        registered = true;
        let outcome: { value: T } | { failed: true };
        try {
          outcome = {
            value: await operation(session, () => {
              discard = true;
            }),
          };
        } catch {
          discard = true;
          outcome = { failed: true };
        }
        let cleanupFailed = false;
        if (discard) {
          poisoned.add(session);
          try {
            await session.discard();
          } catch {
            cleanupFailed = true;
          }
        } else {
          try {
            await session.release();
          } catch {
            poisoned.add(session);
            cleanupFailed = true;
            try {
              await session.discard();
            } catch {
              /* The service failure remains redacted. */
            }
          }
        }
        if ("failed" in outcome || cleanupFailed) throw new Error("SQL Server native verification service failed");
        return outcome.value;
      } catch {
        throw new Error("SQL Server native verification service failed");
      } finally {
        if (session && registered) active.delete(session);
      }
    })();
    this.pending.add(result);
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );
    return result;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      if (this.ownsPool && this.pool.close) {
        try {
          await this.pool.close();
        } catch {
          throw new Error("SQL Server verification pool close failed");
        }
      }
    })();
    return this.closing;
  }
}
/** @internal Reject unsupported procedural, multi-statement and noncanonical parameter probes before acquiring a session. */
export function validateSqlServerVerificationProbe(request: LiveQueryVerificationRequest): readonly number[] {
  if (
    !/^sha256:[a-f\d]{64}$/u.test(request.fingerprint) ||
    !(request.operation === "read" || request.operation === "write") ||
    typeof request.sql !== "string" ||
    request.sql.length > 1024 * 1024 ||
    request.sql.includes("\0") ||
    !request.sql.isWellFormed()
  )
    throw new TypeError("SQL Server native verification requires a bounded query and SHA-256 fingerprint");
  try {
    const statement = parseStatement(request.sql);
    if ((statement.kind === "select" ? "read" : "write") !== request.operation) throw new Error();
    const indices = new Set<number>();
    for (const token of tokenize(request.sql, { sqlFileParameters: true })) {
      if (token.kind !== "parameter") continue;
      const match = /^@__typed_sql_([1-9]\d*)$/u.exec(token.text);
      const index = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(index) || index > 2100) throw new Error();
      indices.add(index);
    }
    const sorted = [...indices].sort((a, b) => a - b);
    if (sorted.some((index, position) => index !== position + 1)) throw new Error();
    return sorted;
  } catch {
    throw new TypeError("SQL Server native verification requires one supported statement with canonical parameters");
  }
}
/** @internal Every lease attests its actual session; no stale snapshot substitutes for the connection. */
export async function sqlServerServiceEvidence(session: SqlServerServiceSession) {
  const { server } = await readSqlServerServerEvidence(session);
  assertSqlServerRuntimeEvidence(server);
  return server;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0"))
    throw new TypeError("Invalid native SQL Server metadata");
  return value;
}
function integer(value: unknown): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) throw new TypeError("Invalid native SQL Server ordinal");
  return number;
}
function flag(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new TypeError("Invalid native SQL Server nullability");
}
/** @internal Native inference, not local resolver guesses, determines declaration targets. */
export async function describeSqlServerParameters(
  session: SqlServerServiceSession,
  sql: string,
  indices: readonly number[],
): Promise<{ readonly fields: readonly LiveQueryVerificationField[]; readonly declarations: string }> {
  const rows = indices.length ? await session.all(sqlServerVerificationQueries.parameters, [sql]) : [];
  if (rows.length !== indices.length) throw new TypeError("SQL Server parameter metadata count is unavailable");
  const fields = new Map<number, LiveQueryVerificationField>();
  for (const row of rows) {
    const name = text(row.name, 128),
      match = /^@__typed_sql_([1-9]\d*)$/u.exec(name),
      index = Number(match?.[1]);
    if (
      !match ||
      !indices.includes(index) ||
      fields.has(index) ||
      !flag(row.suggested_is_input) ||
      flag(row.suggested_is_output)
    )
      throw new TypeError("SQL Server parameter identities are unavailable");
    const native = requireSqlServerNativeType(text(row.suggested_system_type_name));
    if (native.name === "sql_variant") throw new TypeError("SQL Server cannot attest an opaque parameter");
    fields.set(index, { index, name, databaseType: native.text });
  }
  const ordered = indices.map((index) => fields.get(index)!);
  return {
    fields: ordered,
    declarations: ordered.map((field) => `@__typed_sql_${field.index} ${field.databaseType}`).join(", "),
  };
}
/** Native type comparison retains width/precision/scale and any claimed column collation. */
export function compareSqlServerDatabaseTypes(
  expected: string,
  actual: string,
  target: "column" | "parameter",
): "equal" | "different" | "unavailable" {
  const left = parseSqlServerNativeType(expected),
    right = parseSqlServerNativeType(actual);
  if (!left || !right) return "unavailable";
  if ((left.baseText ?? left.text) !== (right.baseText ?? right.text)) return "different";
  if (left.collation) {
    // Undeclared-parameter metadata does not expose a collation name.
    if (!right.collation) return "unavailable";
    if (left.collation.toLowerCase() !== right.collation.toLowerCase()) return "different";
  }
  void target;
  return "equal";
}
/** Driver-neutral native metadata verification; the supplied pool owns driver loading and binding. */
export function createSqlServerLiveVerifier(options: SqlServerLiveVerifierOptions): LiveQueryVerifier {
  const scope = new SqlServerServiceScope(options.pool, options.ownsPool),
    policy = validateSqlServerTypePolicy(options.typePolicy ?? defaultSqlServerTypePolicy);
  let identity: string | undefined;
  const attest = async (session: SqlServerServiceSession) => {
    const server = await sqlServerServiceEvidence(session);
    const current = JSON.stringify(server);
    if (identity !== undefined && current !== identity)
      throw new TypeError("SQL Server verification sessions have incompatible evidence");
    identity = current;
    return server;
  };
  return {
    dialect: "sqlserver",
    adapterVersion: "sqlserver-native-describe-v1",
    typePolicyHash: calculateTypePolicyHash(policy),
    compareDatabaseTypes: compareSqlServerDatabaseTypes,
    server: () =>
      scope.run(async (session) => {
        const server = await attest(session);
        const safe = [
          "compatibilityLevel",
          "collation",
          "defaultSchema",
          "quotedIdentifier",
          "ansiWarnings",
          "arithAbort",
          "concatNullOn",
          "dateFirst",
          "dateFormat",
          "language",
          "engineEdition",
        ];
        return {
          version: server.version,
          features: safe.map((key) => `${key}:${String(server.settings[key])}`).sort(),
        };
      }),
    async verify(request): Promise<LiveQueryVerificationEvidence> {
      const indices = validateSqlServerVerificationProbe(request);
      return scope.run(async (session) => {
        await attest(session);
        const parameters = await describeSqlServerParameters(session, request.sql, indices);
        const rows = await session.all(sqlServerVerificationQueries.columns, [
          request.sql,
          parameters.declarations || null,
        ]);
        if (rows.length > 4096 || (!rows.length && parseStatement(request.sql).kind === "select"))
          throw new TypeError("SQL Server did not attest a first result set");
        const columns: LiveQueryVerificationField[] = [];
        const names = new Set<string>();
        for (const row of rows) {
          if (row.error_number != null || row.error_type != null)
            throw new TypeError("SQL Server cannot describe this query");
          if (flag(row.is_hidden)) continue;
          const index = integer(row.column_ordinal),
            name = text(row.name, 128),
            native = requireSqlServerNativeType(text(row.system_type_name));
          if (index !== columns.length + 1 || names.has(name) || native.name === "sql_variant")
            throw new TypeError("SQL Server result identities are unavailable");
          names.add(name);
          const databaseType =
            row.collation_name != null
              ? requireSqlServerNativeType(`${native.text} COLLATE ${text(row.collation_name, 128)}`).text
              : native.text;
          columns.push({
            index,
            name,
            databaseType,
            ...(flag(row.is_nullable) ? {} : { nullable: false }),
          });
        }
        if (!columns.length && rows.length) throw new TypeError("SQL Server returned no visible metadata");
        return { columns, parameters: parameters.fields };
      });
    },
    close: () => scope.close(),
  };
}
