import type {
  LiveAnalysisFailure,
  NativeContractAdapter,
  NativeContractCandidate,
  NativeContractSession,
  NativeContractValueEvidence,
  NativeQueryContractEvidence,
  QueryContractContext,
} from "@typed-sql/analysis";
import { queryContractDigest } from "@typed-sql/analysis";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { postgresContractAdapterVersion, postgresContractIdentity } from "./contract-profile.js";
import { parseStatement } from "./parser/parser.js";
import type { Expression } from "./parser/types.js";
import type { PgLiveVerifierPool } from "./pg.js";
import { describePgStatement, type PgProtocolDescription } from "./pg-description.js";
import { type PostgresProfileSnapshot, validatePostgresSnapshot } from "./profile-snapshot.js";
import { postgresRuntimeValueType } from "./query.js";
import {
  defaultPostgresTypePolicy,
  isKnownPostgresType,
  mapPostgresType,
  type PostgresTypePolicy,
} from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

const adapterVersion = postgresContractAdapterVersion;
const adapterId = "@typed-sql/postgres/pg-contracts";
const known = <Value>(value: Value) => ({ status: "known" as const, value });
const unknown = (reason: string) => ({ status: "unknown" as const, reason });
const catalogs = [
  "pg_namespace",
  "pg_class",
  "pg_attribute",
  "pg_attrdef",
  "pg_proc",
  "pg_type",
  "pg_enum",
  "pg_range",
  "pg_cast",
  "pg_operator",
  "pg_collation",
  "pg_constraint",
  "pg_rewrite",
  "pg_extension",
  "pg_roles",
  "pg_auth_members",
  "pg_default_acl",
  "pg_policy",
] as const;
// Hash inside the server: routine bodies, role names, settings and catalog text never enter artifacts.
const digestSql = (expression: string) =>
  `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${expression}, 'UTF8')), 'hex')`;
const catalogFingerprint = digestSql(`pg_catalog.jsonb_build_array(
  pg_catalog.current_database(), current_user, session_user,
  ${catalogs.map((name) => `(SELECT ${digestSql(`COALESCE(pg_catalog.string_agg(${digestSql("pg_catalog.to_jsonb(c)::pg_catalog.text")}, '' ORDER BY pg_catalog.to_jsonb(c)::pg_catalog.text), '')`)} FROM pg_catalog.${name} AS c)`).join(",\n")},
  (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(name, setting) ORDER BY name) FROM pg_catalog.pg_settings WHERE name IN
    ('search_path', 'standard_conforming_strings', 'backslash_quote', 'escape_string_warning', 'array_nulls', 'transform_null_equals', 'DateStyle', 'IntervalStyle', 'TimeZone', 'client_encoding', 'server_encoding', 'bytea_output', 'extra_float_digits', 'xmloption', 'lc_numeric', 'lc_time', 'row_security', 'default_transaction_isolation'))
)::pg_catalog.text`);
const catalogFingerprintSql = `SELECT ${catalogFingerprint} AS fingerprint,
 pg_catalog.current_setting('server_version') AS version,
 pg_catalog.pg_current_wal_insert_lsn()::text AS epoch,
 pg_catalog.pg_is_in_recovery() AS recovery,
 pg_catalog.pg_my_temp_schema()::text AS temporary,
 (pg_catalog.current_schemas(true))[1] AS first_schema,
 pg_catalog.current_setting('client_encoding') AS encoding,
 pg_catalog.current_setting('standard_conforming_strings') AS strings,
 (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql') AS extensions`;
const sessionGuardSql =
  "SELECT (pg_catalog.current_schemas(true))[1] AS first_schema, pg_catalog.current_setting('client_encoding') AS encoding, pg_catalog.current_setting('standard_conforming_strings') AS strings, pg_catalog.pg_is_in_recovery() AS recovery, pg_catalog.pg_my_temp_schema()::pg_catalog.text AS temporary, pg_catalog.current_setting('server_version') AS version";
function supportedSession(
  row:
    | { version: string; recovery: boolean; temporary: string; first_schema: string; encoding: string; strings: string }
    | undefined,
): boolean {
  return (
    !!row &&
    /^18\./u.test(row.version) &&
    !row.recovery &&
    row.temporary === "0" &&
    row.first_schema === "pg_catalog" &&
    row.encoding === "UTF8" &&
    row.strings === "on"
  );
}
const epochSql = "SELECT pg_catalog.pg_current_wal_insert_lsn()::text AS epoch";

export class PostgresContractAcquisitionError extends Error {
  readonly code = "POSTGRES_CONTRACT_ACQUISITION";
  constructor(
    readonly reason:
      | "context-changed"
      | "unsupported-context"
      | "protocol-unavailable"
      | "native-failure"
      | "transport-unavailable"
      | "native-rejected"
      | "closed-session",
  ) {
    super(`PostgreSQL query contract acquisition failed: ${reason}`);
    this.name = "PostgresContractAcquisitionError";
  }
}
function classifyError(error: unknown, depth = 0): LiveAnalysisFailure {
  if (depth >= 8) return { kind: "unavailable", code: "postgres-native-failure", retry: "change" };
  if (error instanceof AggregateError) {
    // Acquisition is first: a cleanup outage must not hide a confirmed invalidation.
    const failures = error.errors.slice(0, 16).map((failure) => classifyError(failure, depth + 1));
    return (
      failures.find((failure) => failure.kind === "stale-context") ??
      failures.find((failure) => failure.kind !== "unavailable") ??
      failures.find((failure) => failure.kind === "unavailable" && failure.retry === "change") ??
      failures[0] ?? { kind: "unavailable", code: "postgres-native-failure", retry: "change" }
    );
  }
  if (error instanceof PostgresContractAcquisitionError) {
    if (error.reason === "context-changed") return { kind: "stale-context", code: "postgres-context-changed" };
    if (error.reason === "native-rejected") return { kind: "rejected", code: "postgres-native-rejected" };
    if (error.reason === "unsupported-context" || error.reason === "protocol-unavailable")
      return { kind: "partial", code: `postgres-${error.reason}` };
    return {
      kind: "unavailable",
      code: `postgres-${error.reason}`,
      retry: error.reason === "transport-unavailable" ? "transport" : "change",
    };
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : undefined;
  if (
    (typeof code === "string" &&
      (/^08[A-Z\d]{3}$/u.test(code) ||
        [
          "ECONNREFUSED",
          "ECONNRESET",
          "EPIPE",
          "ETIMEDOUT",
          "ENETUNREACH",
          "EHOSTUNREACH",
          "ENOTFOUND",
          "EAI_AGAIN",
          "57P01",
          "57P02",
          "57P03",
          "53300",
          "57014",
        ].includes(code))) ||
    message === "Connection terminated unexpectedly" ||
    message === "Connection terminated" ||
    message === "Client has encountered a connection error and is not queryable" ||
    message === "Client was closed and is not queryable"
  )
    return { kind: "unavailable", code: "postgres-transport-unavailable", retry: "transport" };
  // Only a server statement diagnostic disproves this candidate. Availability/authentication
  // failures and arbitrary driver exceptions must never be relabeled as invalid SQL.
  if (typeof code === "string" && /^(?:22|23|3D|3F|42)[A-Z\d]{3}$/u.test(code))
    return { kind: "rejected", code: "postgres-native-rejected" };
  return { kind: "unavailable", code: "postgres-native-failure", retry: "change" };
}
function sanitizedFailure(error: unknown): PostgresContractAcquisitionError {
  const failure = classifyError(error);
  return new PostgresContractAcquisitionError(
    failure.kind === "rejected"
      ? "native-rejected"
      : failure.kind === "unavailable" && failure.retry === "transport"
        ? "transport-unavailable"
        : "native-failure",
  );
}
export interface PgNativeContractOptions {
  /** A dedicated application-owned pool. The adapter leases one exclusive client per acquisition. */
  readonly pool: Pick<PgLiveVerifierPool, "connect">;
  readonly schema: PostgresProfileSnapshot;
  readonly typePolicy?: PostgresTypePolicy;
  readonly statementTimeoutMs?: number;
}
export interface PgNativeContractAdapter extends NativeContractAdapter {
  inspectContext(signal?: AbortSignal): Promise<QueryContractContext>;
}
// Initial qualified scope deliberately excludes relation/view/FDW binding, unknown literal input
// coercions and custom type-input functions. Ordinary function bodies are not executed by Parse.
const literalTypes =
  /^(?:pg_catalog\.)?(?:smallint|int2|integer|int4|bigint|int8|real|float4|double precision|float8|numeric|decimal|boolean|bool|text|varchar|character varying|char|character|bytea|date|timestamp(?: without time zone| with time zone)?|timestamptz|time(?: without time zone| with time zone)?|timetz|interval|uuid|json|jsonb)(?:\(\d+(?:,\s*-?\d+)?\))?$/u;
function safeExpression(expression: Expression, typedLiteral = false): boolean {
  if (expression.kind === "parameter") return true;
  if (expression.kind === "literal")
    return typedLiteral || (expression.value !== null && typeof expression.value !== "string");
  if (expression.kind === "cast")
    return literalTypes.test(expression.databaseType.name.toLowerCase()) && safeExpression(expression.expression, true);
  if (expression.kind === "call")
    return (
      !expression.filter &&
      !expression.over &&
      !expression.withinGroup?.length &&
      !expression.orderBy?.length &&
      !expression.distinct &&
      !expression.variadic &&
      expression.arguments.every((argument) => safeExpression(argument))
    );
  return false;
}
function accepts(candidate: NativeContractCandidate): boolean {
  try {
    const statement = parseStatement(candidate.sql);
    return (
      statement.kind === "select" &&
      !statement.with &&
      !statement.from &&
      !statement.joins.length &&
      !statement.where &&
      !statement.groupBy.length &&
      !statement.having &&
      !statement.windows.length &&
      !statement.orderBy.length &&
      !statement.limit &&
      !statement.limitAll &&
      !statement.offset &&
      !statement.fetch &&
      !statement.locking.length &&
      !statement.compounds.length &&
      !statement.distinct &&
      !statement.distinctOn.length &&
      statement.columns.every((column) => safeExpression(column.expression))
    );
  } catch {
    return false;
  }
}
/** PostgreSQL 18 expression-query Parse/Describe adapter. No Bind or Execute is sent for candidate SQL. */
export function createPgNativeContractAdapter(options: PgNativeContractOptions): PgNativeContractAdapter {
  const schema = validatePostgresSnapshot(options.schema);
  const policy = Object.freeze({ ...(options.typePolicy ?? defaultPostgresTypePolicy) });
  const timeout = options.statementTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new RangeError("PostgreSQL description timeout must be 1..60000 ms");
  const open = async (signal?: AbortSignal): Promise<NativeContractSession> => {
    signal?.throwIfAborted();
    const client = await options.pool.connect();
    let closed = false,
      described = false,
      initialEpoch: string | undefined;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await client.query("ROLLBACK");
        client.release();
      } catch (error) {
        client.release(true);
        throw sanitizedFailure(error);
      }
    };
    const requireOpen = () => {
      if (closed) throw new PostgresContractAcquisitionError("closed-session");
      signal?.throwIfAborted();
    };
    const checkEpoch = (epoch: unknown) => {
      if (typeof epoch !== "string" || !/^[A-F\d]+\/[A-F\d]+$/u.test(epoch))
        throw new PostgresContractAcquisitionError("unsupported-context");
      if (initialEpoch !== undefined && epoch !== initialEpoch)
        throw new PostgresContractAcquisitionError("context-changed");
    };
    try {
      signal?.throwIfAborted();
      await client.query("BEGIN READ ONLY");
      const guard = (
        await client.query<{
          version: string;
          recovery: boolean;
          temporary: string;
          first_schema: string;
          encoding: string;
          strings: string;
        }>(sessionGuardSql)
      ).rows[0];
      if (!supportedSession(guard)) throw new PostgresContractAcquisitionError("unsupported-context");
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      await client.query(`SET LOCAL lock_timeout = ${timeout}`);
      await client.query(
        "SELECT pg_catalog.set_config(name, setting, true) FROM pg_catalog.pg_settings WHERE name IN ('search_path', 'standard_conforming_strings', 'backslash_quote', 'array_nulls', 'transform_null_equals', 'DateStyle', 'IntervalStyle', 'TimeZone', 'client_encoding', 'bytea_output', 'extra_float_digits', 'xmloption', 'lc_numeric', 'lc_time', 'row_security')",
      );
      const epoch = (await client.query<{ epoch: string }>(epochSql)).rows[0]?.epoch;
      checkEpoch(epoch);
      initialEpoch = epoch;
    } catch (error) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "PostgreSQL acquisition and cleanup failed");
      }
      throw error;
    }
    return {
      async context(contextSignal) {
        requireOpen();
        contextSignal?.throwIfAborted();
        const row = (
          await client.query<{
            fingerprint: string;
            version: string;
            epoch: string;
            recovery: boolean;
            temporary: string;
            first_schema: string;
            encoding: string;
            strings: string;
            extensions: number;
          }>(catalogFingerprintSql)
        ).rows[0];
        if (!row || !/^[a-f\d]{64}$/u.test(row.fingerprint) || !supportedSession(row) || row.extensions !== 0)
          throw new PostgresContractAcquisitionError("unsupported-context");
        checkEpoch(row.epoch);
        contextSignal?.throwIfAborted();
        return {
          grammar: { id: "postgres", version: POSTGRES_DIALECT_VERSION },
          ...postgresContractIdentity(policy),
          schemaHash: calculateSchemaHash(schema),
          databaseContextHash: queryContractDigest({ version: row.version, catalog: row.fingerprint }),
          typePolicyHash: calculateTypePolicyHash(policy),
        };
      },
      async describe(candidate, describeSignal): Promise<NativeQueryContractEvidence> {
        requireOpen();
        describeSignal?.throwIfAborted();
        if (described || !accepts(candidate)) throw new PostgresContractAcquisitionError("unsupported-context");
        // Metadata queries subsequently replace this unnamed statement; no server/client name
        // cache can accumulate application SQL across live edits.
        const pending = describePgStatement(client, "", candidate.sql);
        if (!pending) throw new PostgresContractAcquisitionError("protocol-unavailable");
        let description: PgProtocolDescription;
        try {
          description = await pending;
          described = true;
        } catch (error) {
          throw sanitizedFailure(error);
        }
        describeSignal?.throwIfAborted();
        const ids = [
          ...new Set([...description.parameters, ...description.columns.map((column) => column.dataTypeID)]),
        ];
        const types = (
          await client.query<{
            oid: number;
            name: string;
            modifier: boolean;
            element: number;
            namespace: string;
            kind: string;
          }>(
            "SELECT t.oid, pg_catalog.format_type(t.oid, NULL) AS name, t.typmodin <> 0 AS modifier, t.typelem AS element, n.nspname AS namespace, t.typtype AS kind FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace WHERE t.oid = ANY($1::oid[])",
            [ids],
          )
        ).rows;
        const metadata = new Map(types.map((type) => [type.oid, type]));
        const interpreted = new Map<string, NativeContractValueEvidence>();
        const field = async (oid: number, modifier?: number): Promise<NativeContractValueEvidence> => {
          requireOpen();
          describeSignal?.throwIfAborted();
          const key = `${oid}:${modifier ?? "parameter"}`;
          const cached = interpreted.get(key);
          if (cached) return cached;
          const type = metadata.get(oid);
          if (
            !type ||
            typeof type.name !== "string" ||
            !type.name.length ||
            typeof type.modifier !== "boolean" ||
            !Number.isSafeInteger(type.element) ||
            type.element < 0 ||
            typeof type.namespace !== "string" ||
            typeof type.kind !== "string"
          )
            throw new PostgresContractAcquisitionError("native-failure");
          let name = type.name;
          if (modifier !== undefined) {
            if (!Number.isSafeInteger(modifier) || modifier < -1)
              throw new PostgresContractAcquisitionError("native-failure");
            const formatted = (
              await client.query<{ name: string }>("SELECT pg_catalog.format_type($1::oid, $2::integer) AS name", [
                oid,
                modifier,
              ])
            ).rows[0]?.name;
            if (typeof formatted !== "string" || !formatted.length)
              throw new PostgresContractAcquisitionError("native-failure");
            name = formatted;
          }
          const mapped =
            type.namespace === "pg_catalog" &&
            type.kind === "b" &&
            isKnownPostgresType(name, schema) &&
            type.element === 0
              ? postgresRuntimeValueType(
                  { databaseType: name, tsType: mapPostgresType(name, policy, schema), nullable: true },
                  policy,
                )
              : "unknown";
          const value: NativeContractValueEvidence = {
            nativeType: known({ name, complete: modifier !== undefined || !type.modifier }),
            runtimeType:
              mapped === "unknown" || mapped === "never"
                ? unknown("native-representation-not-qualified")
                : known(mapped),
            nullable: unknown("row-description-has-no-nullability"),
            descriptor: {
              oid,
              namespace: type.namespace,
              kind: type.kind,
              ...(modifier === undefined ? {} : { typeModifier: modifier }),
            },
          };
          interpreted.set(key, value);
          return value;
        };
        const columns: NativeQueryContractEvidence["columns"][number][] = [];
        for (const column of description.columns)
          columns.push({ ...(await field(column.dataTypeID, column.dataTypeModifier)), name: column.name });
        const parameters: NativeQueryContractEvidence["parameters"][number][] = [];
        for (const [position, oid] of description.parameters.entries())
          parameters.push({ ...(await field(oid)), index: position + 1 });
        checkEpoch((await client.query<{ epoch: string }>(epochSql)).rows[0]?.epoch);
        describeSignal?.throwIfAborted();
        return {
          adapter: { id: adapterId, version: adapterVersion },
          consistency: {
            mechanism: "guarded",
            scope: "postgres18-wal-quiescent-catalogs-owned-readonly-session-no-extensions-expression-query-v1",
          },
          resultKind: "rows",
          columns,
          parameters,
          parameterOccurrences: candidate.parameterOccurrences,
        };
      },
      close,
    };
  };
  return Object.freeze({
    id: adapterId,
    version: adapterVersion,
    grammar: { id: "postgres", version: POSTGRES_DIALECT_VERSION },
    classifyError,
    accept: (candidate: NativeContractCandidate) =>
      accepts(candidate)
        ? { accepted: true as const }
        : { accepted: false as const, reason: "postgres-expression-query-scope" },
    open,
    async inspectContext(signal?: AbortSignal) {
      // Reading a cold catalog can itself advance WAL through hint pages. Retry a fresh capture,
      // never reuse metadata from an unstable interval or relax the guard around description.
      for (let attempt = 0; ; attempt++) {
        const session = await open(signal);
        try {
          return await session.context(signal);
        } catch (error) {
          if (
            !(error instanceof PostgresContractAcquisitionError) ||
            error.reason !== "context-changed" ||
            attempt >= 2
          )
            throw error;
        } finally {
          await session.close();
        }
      }
    },
  });
}
