import {
  canonicalContractData,
  type LiveAnalysisFailure,
  type NativeContractAdapter,
  type NativeContractCandidate,
  type NativeContractSession,
  type NativeQueryContractEvidence,
  type QueryContractContext,
  queryContractDigest,
} from "@typed-sql/analysis";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { assertSqlServerRuntimeEvidence } from "./capabilities.js";
import {
  sqlServerContractColumns,
  sqlServerContractDescriptionQueries,
  sqlServerContractParameters,
} from "./contract-descriptors.js";
import {
  sqlServerContractAdapterVersion,
  sqlServerContractIdentity,
  sqlServerContractPolicy,
} from "./contract-profile.js";
import type { SqlServerServicePool, SqlServerServiceSession } from "./live-verifier.js";
import { parseSqlServerNativeType } from "./native-types.js";
import { parseStatement, tokenize, walkStatement } from "./parser/index.js";
import { readSqlServerServerEvidence } from "./server-evidence.js";
import {
  activeSqlServerServices as activeServices,
  poisonedSqlServerServices as poisonedServices,
} from "./service-registry.js";
import { parseSqlServerSchemaSnapshot, type SqlServerSchemaSnapshot } from "./snapshot.js";
import type { SqlServerTypePolicy } from "./type-policy.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";

const adapterId = "@typed-sql/sqlserver/native-contracts";
export class SqlServerContractAcquisitionError extends Error {
  readonly code = "SQLSERVER_CONTRACT_ACQUISITION";
  constructor(
    readonly reason:
      | "unsupported-context"
      | "unsupported-statement"
      | "context-changed"
      | "metadata-unavailable"
      | "native-rejected"
      | "native-failure"
      | "closed-session"
      | "deadline"
      | "cleanup-failed",
  ) {
    super(`SQL Server query contract acquisition failed: ${reason}`);
    this.name = "SqlServerContractAcquisitionError";
  }
}
export interface SqlServerNativeContractOptions {
  readonly pool: SqlServerServicePool;
  readonly schema: SqlServerSchemaSnapshot;
  readonly typePolicy?: SqlServerTypePolicy;
  readonly statementTimeoutMs?: number;
  readonly leaseTimeoutMs?: number;
}
export interface SqlServerNativeContractAdapter extends NativeContractAdapter {
  inspectContext(signal?: AbortSignal): Promise<QueryContractContext>;
}
/** These queries expose only metadata. Candidate SQL is bound to the description API as data. */
export const sqlServerContractContextQueries = Object.freeze({
  guard:
    "SELECT CONVERT(nvarchar(36),r.database_guid) AS database_guid,CONVERT(nvarchar(36),r.recovery_fork_guid) AS recovery_fork_guid,CONVERT(nvarchar(36),c.connection_id) AS connection_id,@@SPID AS session_id,@@TRANCOUNT AS transaction_count,@@OPTIONS AS session_options,l.log_end_lsn FROM sys.database_recovery_status r CROSS APPLY sys.dm_db_log_stats(r.database_id) l CROSS JOIN sys.dm_exec_connections c WHERE r.database_id=DB_ID() AND c.session_id=@@SPID",
  objects:
    "SELECT o.object_id,o.schema_id,s.name AS schema_name,o.name,o.type,o.parent_object_id,CONVERT(nvarchar(33),o.modify_date,126) AS modified FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 ORDER BY o.object_id",
  columns:
    "SELECT object_id,column_id,name,system_type_id,user_type_id,max_length,precision,scale,collation_name,is_nullable,is_computed,xml_collection_id FROM sys.columns ORDER BY object_id,column_id",
  types:
    "SELECT user_type_id,system_type_id,schema_id,name,is_user_defined,is_assembly_type,max_length,precision,scale,collation_name FROM sys.types ORDER BY user_type_id",
  modules:
    "SELECT object_id,definition,uses_ansi_nulls,uses_quoted_identifier,is_schema_bound,execute_as_principal_id FROM sys.sql_modules ORDER BY object_id",
  principal: "SELECT name,type,usage FROM sys.user_token ORDER BY name,type,usage",
});
type Row = Readonly<Record<string, unknown>>;
function admit(input: NativeContractCandidate): { candidate: NativeContractCandidate; indices: readonly number[] } {
  const candidate = JSON.parse(canonicalContractData(input)) as NativeContractCandidate;
  if (!candidate || typeof candidate.sql !== "string" || !Array.isArray(candidate.parameterOccurrences))
    throw new SqlServerContractAcquisitionError("unsupported-statement");
  const statement = parseStatement(candidate.sql);
  walkStatement(statement, {
    statement(node) {
      if (
        node.kind !== "select" ||
        node.with.length ||
        node.from ||
        node.joins.length ||
        node.where ||
        node.group.length ||
        node.having ||
        node.order.length ||
        node.compounds.length ||
        node.top ||
        node.offset ||
        node.fetch ||
        node.forJson ||
        node.distinct
      )
        throw new SqlServerContractAcquisitionError("unsupported-statement");
    },
    expression(node) {
      if (
        ["subquery", "exists", "default"].includes(node.kind) ||
        (node.kind === "call" && (node.name.parts.length !== 1 || node.over || node.withinGroup)) ||
        (node.kind === "column" && node.name.parts.length !== 1) ||
        (node.kind === "cast" && !parseSqlServerNativeType(node.databaseType))
      )
        throw new SqlServerContractAcquisitionError("unsupported-statement");
    },
  });
  const occurrences = tokenize(candidate.sql, { sqlFileParameters: true })
    .filter((token) => token.kind === "parameter")
    .map((token) => {
      const match = /^@__typed_sql_([1-9]\d*)$/u.exec(token.text),
        index = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(index) || index > 2100)
        throw new SqlServerContractAcquisitionError("unsupported-statement");
      return { index, start: token.range.start, end: token.range.end };
    });
  const indices = [...new Set(occurrences.map(({ index }) => index))].sort((a, b) => a - b);
  if (
    indices.some((index, position) => index !== position + 1) ||
    canonicalContractData(occurrences) !== canonicalContractData(candidate.parameterOccurrences)
  )
    throw new SqlServerContractAcquisitionError("unsupported-statement");
  return { candidate, indices };
}
function errorNumbers(input: unknown): readonly number[] {
  if (!input || typeof input !== "object") return [];
  const own = (object: object, key: string) => Object.getOwnPropertyDescriptor(object, key)?.value;
  const candidates = [own(input, "number"), own(input, "native")];
  const info = own(input, "info");
  if (info && typeof info === "object") candidates.push(own(info, "number"));
  const diagnostics = own(input, "diagnostics");
  if (Array.isArray(diagnostics))
    for (const item of diagnostics.slice(0, 32))
      if (item && typeof item === "object") candidates.push(own(item, "native"));
  return candidates.filter(
    (value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  );
}
function sanitized(input: unknown, description = false): SqlServerContractAcquisitionError {
  if (input instanceof SqlServerContractAcquisitionError) return input;
  const numbers = errorNumbers(input);
  if (numbers.some((number) => [229, 297, 300].includes(number)))
    return new SqlServerContractAcquisitionError("unsupported-context");
  if (description && numbers.some((number) => [102, 156, 195, 207, 208, 209, 4104, 4121, 8116, 8144].includes(number)))
    return new SqlServerContractAcquisitionError("native-rejected");
  if (description && numbers.some((number) => number >= 11501 && number <= 11599))
    return new SqlServerContractAcquisitionError("metadata-unavailable");
  return new SqlServerContractAcquisitionError("native-failure");
}
function bound<Value>(work: Promise<Value>, milliseconds: number, signal?: AbortSignal): Promise<Value> {
  if (signal?.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: Value } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const abort = () => finish({ error: signal!.reason }),
      timer = setTimeout(() => finish({ error: new SqlServerContractAcquisitionError("deadline") }), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    );
  });
}
/** Development-only native acquisition. A quiescence guard covers both context reads and description. */
export function createSqlServerNativeContractAdapter(
  options: SqlServerNativeContractOptions,
): SqlServerNativeContractAdapter {
  const schema = parseSqlServerSchemaSnapshot(JSON.parse(canonicalContractData(options.schema))),
    policy = sqlServerContractPolicy(options.typePolicy);
  if (typeof options.pool?.acquire !== "function")
    throw new TypeError("SQL Server native contracts require an exclusive service pool");
  const timeout = options.statementTimeoutMs ?? 5000,
    leaseTimeout = options.leaseTimeoutMs ?? 30000;
  if ([timeout, leaseTimeout].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 300000))
    throw new RangeError("Invalid SQL Server native deadline");
  const identity = sqlServerContractIdentity(policy);
  let cleanupFault = false;
  const open = async (initialSignal?: AbortSignal): Promise<NativeContractSession> => {
    initialSignal?.throwIfAborted();
    if (cleanupFault) throw new SqlServerContractAcquisitionError("cleanup-failed");
    let abandoned = false;
    const creation = Promise.resolve().then(() => options.pool.acquire());
    void creation
      .then(async (session) => {
        if (abandoned && session && !activeServices.has(session) && !poisonedServices.has(session)) {
          poisonedServices.add(session);
          try {
            await bound(
              Promise.resolve().then(() => session.discard()),
              timeout,
            );
          } catch {
            cleanupFault = true;
          }
        }
      })
      .catch(() => {});
    let session: SqlServerServiceSession;
    try {
      session = await bound(creation, timeout, initialSignal);
    } catch (error) {
      abandoned = true;
      throw sanitized(error);
    }
    if (
      !session ||
      typeof session.all !== "function" ||
      typeof session.release !== "function" ||
      typeof session.discard !== "function" ||
      activeServices.has(session) ||
      poisonedServices.has(session)
    )
      throw new SqlServerContractAcquisitionError("unsupported-context");
    activeServices.add(session);
    let closed = false,
      busy = false,
      poisoned = false,
      closing: Promise<void> | undefined;
    const lifetime = new AbortController();
    const abort = () => lifetime.abort(initialSignal?.reason ?? new SqlServerContractAcquisitionError("deadline"));
    const timer = setTimeout(() => lifetime.abort(new SqlServerContractAcquisitionError("deadline")), leaseTimeout);
    const close = (discard = false): Promise<void> => {
      poisoned ||= discard || busy;
      if (closing) return closing;
      closed = true;
      clearTimeout(timer);
      initialSignal?.removeEventListener("abort", abort);
      closing = (async () => {
        try {
          if (poisoned) {
            poisonedServices.add(session);
            await bound(
              Promise.resolve().then(() => session.discard()),
              timeout,
            );
          } else
            try {
              await bound(
                Promise.resolve().then(() => session.release()),
                timeout,
              );
            } catch {
              poisonedServices.add(session);
              await bound(
                Promise.resolve().then(() => session.discard()),
                timeout,
              );
              throw new SqlServerContractAcquisitionError("cleanup-failed");
            }
        } catch {
          cleanupFault = true;
          throw new SqlServerContractAcquisitionError("cleanup-failed");
        } finally {
          activeServices.delete(session);
        }
      })();
      return closing;
    };
    lifetime.signal.addEventListener(
      "abort",
      () => {
        void close(true).catch(() => {});
      },
      { once: true },
    );
    initialSignal?.addEventListener("abort", abort, { once: true });
    if (initialSignal?.aborted) abort();
    const all = async (
      sql: string,
      values?: readonly unknown[],
      signal?: AbortSignal,
      description = false,
    ): Promise<readonly Row[]> => {
      if (closed) throw new SqlServerContractAcquisitionError("closed-session");
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      try {
        combined.throwIfAborted();
        const result = await bound(
          Promise.resolve().then(() => session.all(sql, values)),
          timeout,
          combined,
        );
        combined.throwIfAborted();
        if (closed) throw new SqlServerContractAcquisitionError("closed-session");
        return JSON.parse(canonicalContractData(result));
      } catch (error) {
        poisoned = true;
        throw sanitized(error, description);
      }
    };
    const guard = async (signal?: AbortSignal): Promise<Row> => {
      const rows = await all(sqlServerContractContextQueries.guard, undefined, signal);
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        typeof row.log_end_lsn !== "string" ||
        !/^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{4}$/iu.test(row.log_end_lsn) ||
        !["database_guid", "recovery_fork_guid", "connection_id"].every(
          (key) =>
            typeof row[key] === "string" &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(row[key] as string),
        ) ||
        (row.transaction_count !== 0 && row.transaction_count !== "0") ||
        !Number.isSafeInteger(Number(row.session_id)) ||
        Number(row.session_id) < 1 ||
        !(
          typeof row.session_options === "number" ||
          (typeof row.session_options === "string" && /^\d+$/u.test(row.session_options))
        ) ||
        !Number.isSafeInteger(Number(row.session_options)) ||
        Number(row.session_options) < 0
      )
        throw new SqlServerContractAcquisitionError("unsupported-context");
      return row;
    };
    try {
      const first = await guard(initialSignal);
      const attest = async (signal?: AbortSignal) => {
        try {
          const evidence = await readSqlServerServerEvidence({
            all: <RowType extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) =>
              all(sql, values, signal) as Promise<readonly RowType[]>,
          });
          assertSqlServerRuntimeEvidence(evidence.server);
          if (!evidence.canViewDefinition) throw new SqlServerContractAcquisitionError("unsupported-context");
          return evidence;
        } catch (error) {
          if (error instanceof TypeError) throw new SqlServerContractAcquisitionError("unsupported-context");
          throw error;
        }
      };
      const evidence = await attest(initialSignal);
      const catalog: unknown[] = [];
      for (const key of ["objects", "columns", "types", "modules", "principal"] as const)
        catalog.push(await all(sqlServerContractContextQueries[key], undefined, initialSignal));
      const selected = Object.freeze<QueryContractContext>({
        grammar: Object.freeze({ id: "sqlserver", version: SQLSERVER_DIALECT_VERSION }),
        ...identity,
        schemaHash: calculateSchemaHash(schema),
        typePolicyHash: calculateTypePolicyHash(policy),
        databaseContextHash: queryContractDigest({
          server: evidence.server,
          database: first.database_guid,
          recoveryFork: first.recovery_fork_guid,
          sessionOptions: first.session_options,
          catalog,
        }),
      });
      const consistent = async (signal?: AbortSignal) => {
        const current = await guard(signal);
        let currentEvidence: typeof evidence;
        try {
          currentEvidence = await attest(signal);
        } catch (error) {
          if (error instanceof SqlServerContractAcquisitionError && error.reason === "unsupported-context")
            throw new SqlServerContractAcquisitionError("context-changed");
          throw error;
        }
        const after = await guard(signal);
        if (
          canonicalContractData(current) !== canonicalContractData(first) ||
          canonicalContractData(after) !== canonicalContractData(first) ||
          canonicalContractData(currentEvidence) !== canonicalContractData(evidence)
        ) {
          poisoned = true;
          throw new SqlServerContractAcquisitionError("context-changed");
        }
      };
      await consistent(initialSignal);
      const operation = async <Value>(run: () => Promise<Value>): Promise<Value> => {
        if (closed) throw new SqlServerContractAcquisitionError("closed-session");
        if (busy) throw new SqlServerContractAcquisitionError("unsupported-context");
        busy = true;
        try {
          return await run();
        } catch (error) {
          await close(true);
          throw sanitized(error);
        } finally {
          busy = false;
        }
      };
      return {
        context: (signal) =>
          operation(async () => {
            await consistent(signal);
            return selected;
          }),
        describe: (input, signal) =>
          operation(async (): Promise<NativeQueryContractEvidence> => {
            const { candidate, indices } = admit(input);
            await consistent(signal);
            const rows = indices.length
              ? await all(sqlServerContractDescriptionQueries.parameters, [candidate.sql], signal, true)
              : [];
            let parameters: ReturnType<typeof sqlServerContractParameters>;
            try {
              parameters = sqlServerContractParameters(rows, indices, policy);
            } catch {
              throw new SqlServerContractAcquisitionError("metadata-unavailable");
            }
            const result = await all(
              sqlServerContractDescriptionQueries.columns,
              [candidate.sql, parameters.declarations || null],
              signal,
              true,
            );
            const nativeError = result.find((row) => row.error_number != null);
            if (nativeError) {
              const failure = sanitized({ number: Number(nativeError.error_number) }, true);
              throw failure.reason === "native-rejected"
                ? failure
                : new SqlServerContractAcquisitionError("metadata-unavailable");
            }
            let columns: NativeQueryContractEvidence["columns"];
            try {
              columns = sqlServerContractColumns(result, policy);
            } catch {
              throw new SqlServerContractAcquisitionError("metadata-unavailable");
            }
            await consistent(signal);
            return {
              adapter: { id: adapterId, version: sqlServerContractAdapterVersion },
              consistency: { mechanism: "guarded", scope: "sqlserver-exclusive-log-quiescent-builtin-expressions-v1" },
              resultKind: "rows",
              columns,
              parameters: parameters.parameters,
              parameterOccurrences: candidate.parameterOccurrences,
            };
          }),
        close: () => close(poisoned),
      };
    } catch (error) {
      await close(true);
      throw sanitized(error);
    }
  };
  return Object.freeze<SqlServerNativeContractAdapter>({
    id: adapterId,
    version: sqlServerContractAdapterVersion,
    grammar: { id: "sqlserver", version: SQLSERVER_DIALECT_VERSION },
    accept(candidate) {
      try {
        admit(candidate);
        return { accepted: true };
      } catch {
        return { accepted: false, reason: "sqlserver-builtin-expression-scope" };
      }
    },
    open,
    classifyError(error): LiveAnalysisFailure {
      const failure = sanitized(error);
      if (failure.reason === "context-changed") return { kind: "stale-context", code: "sqlserver-context-changed" };
      if (failure.reason === "native-rejected") return { kind: "rejected", code: "sqlserver-native-rejected" };
      if (failure.reason === "metadata-unavailable")
        return { kind: "partial", code: "sqlserver-native-metadata-unavailable" };
      return {
        kind: "unavailable",
        code: "sqlserver-native-unavailable",
        retry: ["unsupported-context", "unsupported-statement", "cleanup-failed"].includes(failure.reason)
          ? "change"
          : "transport",
      };
    },
    async inspectContext(signal) {
      const session = await open(signal);
      let context: QueryContractContext;
      try {
        context = await session.context(signal);
      } finally {
        await session.close();
      }
      signal?.throwIfAborted();
      return context;
    },
  });
}
