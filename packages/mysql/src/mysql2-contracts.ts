import {
  canonicalContractData,
  type LiveAnalysisFailure,
  type NativeContractAdapter,
  type NativeContractCandidate,
  type NativeContractSession,
  type NativeContractValueEvidence,
  type NativeQueryContractEvidence,
  type QueryContractContext,
  queryContractDigest,
} from "@typed-sql/analysis";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { unmodeledMySqlSqlModes } from "./capabilities.js";
import { mySqlContractAdapterVersion, mySqlContractIdentity, validateMySqlContractPolicy } from "./contract-profile.js";
import { loadMySql2Driver } from "./mysql2.js";
import { type Expression, type NamedTableReference, parseStatement, tokenize, walkStatement } from "./parser/index.js";
import { type MySqlSchemaSnapshot, mysqlProfile } from "./profile.js";
import { type MySqlProtocolField, mySqlProtocolFlags, mySqlProtocolType } from "./protocol-fields.js";
import { mysqlRuntimeValueType } from "./query.js";
import { MYSQL_SUPPORT_POLICY } from "./support.js";
import { defaultMySqlTypePolicy, isKnownMySqlType, type MySqlTypePolicy, mapMySqlType } from "./type-policy.js";
import { MYSQL_DIALECT_VERSION } from "./version.js";

const adapterId = "@typed-sql/mysql/mysql2-contracts";
const known = <Value>(value: Value) => ({ status: "known" as const, value });
const unknown = (reason: string) => ({ status: "unknown" as const, reason });
function sanitized(error: unknown): MySqlContractAcquisitionError {
  if (error instanceof MySqlContractAcquisitionError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^(?:ER_SPECIFIC_ACCESS_DENIED|ER_TABLEACCESS_DENIED|ER_DBACCESS_DENIED)/u.test(code))
    return new MySqlContractAcquisitionError("permission-unavailable");
  return new MySqlContractAcquisitionError(
    typeof code === "string" &&
      /^(?:ECONN|EHOST|ENET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|PROTOCOL_CONNECTION|PROTOCOL_ENQUEUE)/u.test(code)
      ? "transport-unavailable"
      : "native-failure",
  );
}
const protect = async <Value>(work: () => Promise<Value>): Promise<Value> => {
  try {
    return await work();
  } catch (error) {
    throw sanitized(error);
  }
};
const modes = (value: string) => value.split(",").filter(Boolean).sort().join(",");
const fold = (value: string) => value.replace(/[A-Z]/gu, (char) => char.toLowerCase());
const asciiIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// Connection/statement clocks and transaction history do not describe expression binding.
// DDL is protected by the backup lock; ordinary writes must not invalidate semantic context.
const incidentalVariables =
  "('pseudo_thread_id','statement_id','timestamp','gtid_executed','gtid_owned','gtid_purged')";
export class MySqlContractAcquisitionError extends Error {
  readonly code = "MYSQL_CONTRACT_ACQUISITION";
  constructor(
    readonly reason:
      | "unsupported-context"
      | "unsupported-statement"
      | "metadata-unavailable"
      | "native-failure"
      | "native-rejected"
      | "closed-session"
      | "transport-unavailable"
      | "permission-unavailable",
  ) {
    super(`MySQL query contract acquisition failed: ${reason}`);
    this.name = "MySqlContractAcquisitionError";
  }
}
function classifyError(error: unknown, depth = 0): LiveAnalysisFailure {
  if (depth < 8 && error instanceof AggregateError) {
    const outcomes = error.errors.slice(0, 16).map((item) => classifyError(item, depth + 1));
    return (
      outcomes.find((item) => item.kind === "rejected" || item.kind === "conflict" || item.kind === "stale-context") ??
      outcomes.find((item) => item.kind === "partial") ??
      outcomes[0] ?? { kind: "unavailable", code: "mysql-native-failure", retry: "change" }
    );
  }
  if (error instanceof MySqlContractAcquisitionError) {
    if (
      error.reason.startsWith("unsupported-") ||
      error.reason === "metadata-unavailable" ||
      error.reason === "permission-unavailable"
    )
      return { kind: "partial", code: `mysql-${error.reason}` };
    if (error.reason === "native-rejected") return { kind: "rejected", code: "mysql-native-rejected" };
    if (error.reason === "transport-unavailable")
      return { kind: "unavailable", code: "mysql-transport-unavailable", retry: "transport" };
  }
  return { kind: "unavailable", code: "mysql-native-failure", retry: "change" };
}
export interface MySql2NativeContractOptions {
  readonly connectionUri: string | (() => string | Promise<string>);
  readonly schema: MySqlSchemaSnapshot;
  readonly typePolicy?: MySqlTypePolicy;
  readonly driverImporter?: () => Promise<typeof import("mysql2/promise")>;
  readonly statementTimeoutMs?: number;
}
export interface MySql2NativeContractAdapter extends NativeContractAdapter {
  inspectContext(signal?: AbortSignal): Promise<QueryContractContext>;
}
function select(
  candidate: NativeContractCandidate,
  sqlMode: string,
): {
  readonly names: ReadonlySet<string>;
  readonly expressions: readonly Expression[];
  readonly tables: readonly NamedTableReference[];
  readonly hasStar: boolean;
} {
  if (!candidate.sql.length || candidate.sql.length > 8 * 1024 * 1024 || /\/\*[!+]/u.test(candidate.sql))
    throw new MySqlContractAcquisitionError("unsupported-statement");
  const statement = parseStatement(candidate.sql, { sqlMode });
  if (
    statement.kind !== "select" ||
    statement.with ||
    statement.queryValues ||
    statement.groupBy.length ||
    statement.having ||
    statement.windows.length ||
    statement.orderBy.length ||
    statement.limit ||
    statement.offset ||
    statement.locking.length ||
    statement.compounds.length ||
    statement.distinct ||
    statement.distinctOn.length
  )
    throw new MySqlContractAcquisitionError("unsupported-statement");
  const tables = [...(statement.from ? [statement.from] : []), ...statement.joins.map((join) => join.table)];
  if (
    tables.some((table) => table.kind !== "table" || table.lateral || table.partitions?.length) ||
    (statement.where && !tables.length)
  )
    throw new MySqlContractAcquisitionError("unsupported-statement");
  const occurrences = tokenize(candidate.sql, { sqlMode })
    .filter((token) => token.kind === "parameter")
    .map((token) => {
      if (token.text !== "?") throw new MySqlContractAcquisitionError("unsupported-statement");
      return { index: Number(token.value), start: token.range.start, end: token.range.end };
    });
  if (canonicalContractData(occurrences) !== canonicalContractData(candidate.parameterOccurrences))
    throw new MySqlContractAcquisitionError("unsupported-statement");
  const names = new Set<string>();
  walkStatement(statement, {
    expression(expression) {
      if (
        (["column", "star"].includes(expression.kind) && !tables.length) ||
        ["subquery", "exists", "row", "array"].includes(expression.kind)
      )
        throw new MySqlContractAcquisitionError("unsupported-statement");
      if (expression.kind === "in" && !Array.isArray(expression.values))
        throw new MySqlContractAcquisitionError("unsupported-statement");
      if (expression.kind === "call") {
        if (
          expression.schema ||
          expression.name.quoted ||
          !asciiIdentifier.test(expression.name.name) ||
          expression.distinct ||
          expression.filter ||
          expression.over
        )
          throw new MySqlContractAcquisitionError("unsupported-statement");
        names.add(fold(expression.name.name));
      }
    },
  });
  return {
    names,
    expressions: statement.columns.map((column) => column.expression),
    tables: tables as readonly NamedTableReference[],
    hasStar: statement.columns.some((column) => column.expression.kind === "star"),
  };
}
function projectionExpressions(
  expressions: readonly Expression[],
  columns: number,
): readonly (Expression | undefined)[] {
  const firstStar = expressions.findIndex((expression) => expression.kind === "star");
  if (firstStar < 0) return expressions;
  const trailing = expressions.length - 1 - expressions.findLastIndex((expression) => expression.kind === "star");
  // Star widths are not known from syntax. Prefix/suffix positions are still exact; slots
  // between stars cannot borrow a literal bound from a guessed projection position.
  return Array.from({ length: columns }, (_, index) =>
    index < firstStar
      ? expressions[index]
      : index >= columns - trailing
        ? expressions[expressions.length - columns + index]
        : undefined,
  );
}
function integerLiteral(expression: Expression | undefined): bigint | undefined {
  if (expression?.kind === "literal" && expression.numericText && /^\d{1,20}$/u.test(expression.numericText)) {
    const value = BigInt(expression.numericText);
    return value <= 2147483647n ? value : undefined;
  }
  if (expression?.kind === "unary" && ["+", "-"].includes(expression.operator)) {
    const value = integerLiteral(expression.expression);
    return value === undefined ? undefined : expression.operator === "-" ? -value : value;
  }
  return undefined;
}
function field(
  value: MySqlProtocolField,
  policy: MySqlTypePolicy,
  parameter: boolean,
  schema: MySqlSchemaSnapshot,
  expression?: Expression,
): NativeContractValueEvidence {
  const name = mySqlProtocolType(value),
    flags = mySqlProtocolFlags(value);
  let type =
    name && isKnownMySqlType(name, schema)
      ? mysqlRuntimeValueType(
          { databaseType: name, tsType: mapMySqlType(name, policy, schema), nullable: true },
          policy,
        )
      : "unknown";
  const literal = integerLiteral(expression);
  const literalBound = name === "bigint" && literal !== undefined && literal >= -2147483648n && literal <= 2147483647n;
  if (literalBound) type = "number";
  // The wire family does not establish character lengths/collations or temporal dimensions.
  const complete = [0, 1, 2, 3, 8, 9, 13, 246].includes(value.columnType ?? value.type ?? -1);
  return {
    nativeType: name ? known({ name, complete }) : unknown("native-type-facets-unavailable"),
    runtimeType:
      type === "unknown" || type === "never" ? unknown("native-runtime-representation-unavailable") : known(type),
    nullable:
      parameter || flags === undefined
        ? unknown("native-input-nullability-unavailable")
        : { status: "known", value: (flags & 1) === 0, precision: (flags & 1) === 0 ? "upper-bound" : "exact" },
    descriptor: Object.fromEntries(
      Object.entries({
        integerLiteralBound: literalBound ? "int" : undefined,
        type: value.columnType ?? value.type,
        flags,
        characterSet: value.characterSet,
        columnLength: value.columnLength ?? value.length,
        decimals: value.decimals,
      }).filter(([, item]) => item !== undefined),
    ),
  };
}
/** Owns a fresh connection and a shared backup lock; no application statement is bound or executed. */
export function createMySql2NativeContractAdapter(options: MySql2NativeContractOptions): MySql2NativeContractAdapter {
  const policy = validateMySqlContractPolicy(options.typePolicy ?? defaultMySqlTypePolicy);
  const schema = mysqlProfile({ typePolicy: policy }).validateSnapshot(options.schema);
  if (schema.formatVersion !== 2 || typeof schema.server.settings.sqlMode !== "string")
    throw new TypeError("MySQL native acquisition requires a versioned schema with SQL-mode evidence");
  const sqlMode = schema.server.settings.sqlMode;
  if (unmodeledMySqlSqlModes(sqlMode).length) throw new MySqlContractAcquisitionError("unsupported-context");
  const timeout = options.statementTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
    throw new RangeError("Invalid MySQL acquisition deadline");
  const open = async (signal?: AbortSignal): Promise<NativeContractSession> => {
    signal?.throwIfAborted();
    let connection: Connection | undefined;
    let closed = false,
      expired = false,
      locked = false,
      described = false;
    let cancelBoundary: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelBoundary = reject;
    });
    // An idle lease can expire without a pending initialization wait.
    void cancelled.catch(() => {});
    const abort = () => {
      expired = true;
      connection?.destroy();
      cancelBoundary(new MySqlContractAcquisitionError("native-failure"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    const wait = <Value>(work: Promise<Value>, dispose?: (value: Value) => void): Promise<Value> =>
      Promise.race([
        work.then((value) => {
          if (closed || expired) {
            dispose?.(value);
            throw new MySqlContractAcquisitionError("native-failure");
          }
          return value;
        }),
        cancelled,
      ]);
    const requireOpen = (active?: AbortSignal): Connection => {
      signal?.throwIfAborted();
      active?.throwIfAborted();
      if (closed || !connection) throw new MySqlContractAcquisitionError("closed-session");
      if (expired) throw new MySqlContractAcquisitionError("native-failure");
      return connection;
    };
    const read = async (sql: string, values?: readonly string[]): Promise<RowDataPacket[]> =>
      (await wait(requireOpen().query<RowDataPacket[]>(sql, values ? [...values] : undefined)))[0];
    const control = async (sql: string): Promise<void> => {
      await wait(requireOpen().query(sql));
    };
    const operation = async <Value>(active: AbortSignal | undefined, work: () => Promise<Value>): Promise<Value> => {
      active?.throwIfAborted();
      if (active !== signal) active?.addEventListener("abort", abort, { once: true });
      try {
        return await wait(Promise.resolve().then(work));
      } finally {
        if (active !== signal) active?.removeEventListener("abort", abort);
      }
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        if (connection && !expired) {
          await Promise.race([connection.query("ROLLBACK"), cancelled]);
          if (locked) await Promise.race([connection.query("UNLOCK INSTANCE"), cancelled]);
          await Promise.race([connection.end(), cancelled]);
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        connection?.destroy();
      }
    };
    try {
      const driver = await wait(loadMySql2Driver(options.driverImporter));
      const uri = await wait(
        Promise.resolve().then(() =>
          typeof options.connectionUri === "function" ? options.connectionUri() : options.connectionUri,
        ),
      );
      if (!uri.length || expired) throw new MySqlContractAcquisitionError("native-failure");
      connection = await wait(
        driver.createConnection({
          uri,
          multipleStatements: false,
          namedPlaceholders: false,
          rowsAsArray: false,
          supportBigNumbers: true,
          bigNumberStrings: true,
          connectTimeout: timeout,
        }),
        (late) => late.destroy(),
      );
      requireOpen();
      await control(`SET SESSION lock_wait_timeout=${Math.max(1, Math.ceil(timeout / 1000))}`);
      await control("LOCK INSTANCE FOR BACKUP");
      locked = true;
      await control("START TRANSACTION READ ONLY");
      const [server] = await read(
        "SELECT VERSION() AS version,@@version_comment AS edition,@@server_uuid AS server,@@session.sql_mode AS sqlMode,@@lower_case_table_names AS lowerCaseTables,DATABASE() AS db,CURRENT_USER() AS principal",
      );
      if (
        !server ||
        !MYSQL_SUPPORT_POLICY.stable.some((target) => target.matrixVersion === server.version) ||
        server.version !== schema.server.version ||
        !String(server.edition).includes("MySQL") ||
        modes(server.sqlMode) !== modes(sqlMode)
      )
        throw new MySqlContractAcquisitionError("unsupported-context");
      const routines = await read(
        "SELECT ROUTINE_SCHEMA,ROUTINE_NAME,ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_TYPE='FUNCTION' ORDER BY ROUTINE_NAME LIMIT 4097",
      );
      const udfs = await read(
        "SELECT UDF_NAME FROM performance_schema.user_defined_functions ORDER BY UDF_NAME LIMIT 4097",
      );
      if (routines.length > 4096 || udfs.length > 4096) throw new MySqlContractAcquisitionError("metadata-unavailable");
      const routineNames = routines.map((row) => row.ROUTINE_NAME),
        udfNames = udfs.map((row) => row.UDF_NAME);
      if ([...routineNames, ...udfNames].some((name) => typeof name !== "string" || !name.length || name.length > 256))
        throw new MySqlContractAcquisitionError("metadata-unavailable");
      const forbidden = new Set([...routineNames.map(fold), ...udfNames.map(fold)]);
      const tables = await read(
        "SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COLLATION,CREATE_OPTIONS FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME LIMIT 4097",
      );
      const columns = await read(
        "SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_DEFAULT,IS_NULLABLE,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_OCTET_LENGTH,NUMERIC_PRECISION,NUMERIC_SCALE,DATETIME_PRECISION,CHARACTER_SET_NAME,COLLATION_NAME,COLUMN_TYPE,COLUMN_KEY,EXTRA,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT 65537",
      );
      if (tables.length > 4096 || columns.length > 65536)
        throw new MySqlContractAcquisitionError("metadata-unavailable");
      const context = async (active?: AbortSignal): Promise<QueryContractContext> => {
        requireOpen(active);
        const roles = await read(
          "SELECT ROLE_NAME,ROLE_HOST FROM information_schema.ENABLED_ROLES ORDER BY ROLE_NAME,ROLE_HOST LIMIT 4097",
        );
        if (roles.length > 4096) throw new MySqlContractAcquisitionError("metadata-unavailable");
        const quoted = (value: unknown): string => {
          if (typeof value !== "string" || !value.length || value.length > 256 || value.includes("\0"))
            throw new MySqlContractAcquisitionError("metadata-unavailable");
          return `\`${value.replaceAll("`", "``")}\``;
        };
        // Role names are native metadata, quoted as identifiers; never splice CURRENT_ROLE text.
        const using = roles.map((role) => `${quoted(role.ROLE_NAME)}@${quoted(role.ROLE_HOST)}`).join(",");
        if (using.length > 65536) throw new MySqlContractAcquisitionError("metadata-unavailable");
        const grants = async (sql: string) => {
          const rows = await read(sql);
          if (!rows.length || rows.length > 4096) throw new MySqlContractAcquisitionError("metadata-unavailable");
          return rows
            .map((row) => {
              const values = Object.values(row);
              if (values.length !== 1 || typeof values[0] !== "string" || !values[0].length || values[0].length > 65536)
                throw new MySqlContractAcquisitionError("metadata-unavailable");
              return values[0];
            })
            .sort();
        };
        const directGrants = await grants("SHOW GRANTS");
        const effectiveGrants = using ? await grants(`SHOW GRANTS FOR CURRENT_USER USING ${using}`) : directGrants;
        const session = await read(
          `SELECT VARIABLE_NAME,VARIABLE_VALUE FROM performance_schema.session_variables WHERE VARIABLE_NAME NOT IN ${incidentalVariables} ORDER BY VARIABLE_NAME LIMIT 4097`,
        );
        const global = await read(
          `SELECT VARIABLE_NAME,VARIABLE_VALUE FROM performance_schema.global_variables WHERE VARIABLE_NAME NOT IN ${incidentalVariables} ORDER BY VARIABLE_NAME LIMIT 4097`,
        );
        if (session.length > 4096 || global.length > 4096)
          throw new MySqlContractAcquisitionError("metadata-unavailable");
        requireOpen(active);
        return {
          grammar: { id: "mysql", version: MYSQL_DIALECT_VERSION },
          ...mySqlContractIdentity(policy),
          schemaHash: calculateSchemaHash(schema),
          typePolicyHash: calculateTypePolicyHash(policy),
          databaseContextHash: queryContractDigest({
            server,
            routines,
            udfs,
            tables,
            columns,
            roles,
            directGrants,
            effectiveGrants,
            session,
            global,
          }),
        };
      };
      return {
        context: (active?: AbortSignal) => operation(active, () => context(active)),
        async describe(candidate: NativeContractCandidate, active?: AbortSignal) {
          return operation(active, async () => {
            requireOpen(active);
            const selection = select(candidate, sqlMode);
            if (described || [...selection.names].some((name) => forbidden.has(name)))
              throw new MySqlContractAcquisitionError("unsupported-statement");
            for (const table of selection.tables) {
              // The qualified native engines use case-sensitive table names. Do not approximate
              // filesystem/Unicode identifier equivalence for other lower_case_table_names modes.
              if (
                (server.lowerCaseTables !== 0 && server.lowerCaseTables !== "0") ||
                (table.schema && table.schema.name !== server.db)
              )
                throw new MySqlContractAcquisitionError("unsupported-statement");
              const matches = tables.filter(
                (row) => row.TABLE_NAME === table.name.name && row.TABLE_SCHEMA === server.db,
              );
              const relation = matches[0];
              const fields = columns.filter(
                (row) => row.TABLE_NAME === table.name.name && row.TABLE_SCHEMA === server.db,
              );
              if (
                matches.length !== 1 ||
                relation?.TABLE_TYPE !== "BASE TABLE" ||
                relation.ENGINE !== "InnoDB" ||
                !fields.length ||
                fields.some(
                  (row) =>
                    typeof row.EXTRA !== "string" ||
                    typeof row.GENERATION_EXPRESSION !== "string" ||
                    row.GENERATION_EXPRESSION.length ||
                    /(?:^|\s)(?:VIRTUAL|STORED)\s+GENERATED(?:\s|$)/iu.test(row.EXTRA),
                )
              )
                throw new MySqlContractAcquisitionError("unsupported-statement");
            }
            described = true;
            if (selection.names.size > 4096) throw new MySqlContractAcquisitionError("unsupported-statement");
            const names = [...selection.names];
            if (names.length) {
              const slots = names.map(() => "?").join(",");
              // The server owns Unicode/collation equivalence. ASCII folding cannot exclude
              // an accent-equivalent stored routine or a loadable UDF alias.
              for (const [catalog, field, filter, present] of [
                [
                  "information_schema.ROUTINES",
                  "ROUTINE_NAME",
                  "ROUTINE_SCHEMA=DATABASE() AND ROUTINE_TYPE='FUNCTION' AND ",
                  routineNames,
                ],
                ["performance_schema.user_defined_functions", "UDF_NAME", "", udfNames],
              ] as const) {
                if (
                  present.some((name) => !asciiIdentifier.test(name)) &&
                  (
                    await read(
                      `SELECT 1 AS present FROM ${catalog} WHERE ${filter}CONVERT(${field} USING utf8mb3) COLLATE utf8mb3_general_ci IN (${slots}) LIMIT 1`,
                      names,
                    )
                  ).length
                )
                  throw new MySqlContractAcquisitionError("unsupported-statement");
              }
            }
            let statement: Awaited<ReturnType<Connection["prepare"]>>;
            try {
              statement = await requireOpen(active).prepare(candidate.sql);
            } catch (error) {
              const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
              const detail =
                error && typeof error === "object"
                  ? (error as { fatal?: boolean; errno?: number; sqlState?: string })
                  : {};
              if (
                typeof code === "string" &&
                code.startsWith("ER_") &&
                !detail.fatal &&
                !/^(?:08|40)/u.test(detail.sqlState ?? "") &&
                ![1037, 1038, 1040, 1041, 1053, 1205, 1213, 1317].includes(detail.errno ?? -1) &&
                !/ACCESS|DENIED|LOCK|TIMEOUT|CONNECTION|RESOURCE/u.test(code)
              )
                throw new MySqlContractAcquisitionError("native-rejected");
              throw sanitized(error);
            }
            try {
              requireOpen(active);
              const native = (
                statement as unknown as {
                  readonly statement?: {
                    readonly columns?: readonly MySqlProtocolField[];
                    readonly parameters?: readonly MySqlProtocolField[];
                  };
                }
              ).statement;
              if (
                !native ||
                !Array.isArray(native.columns) ||
                !native.columns.length ||
                (selection.hasStar
                  ? native.columns.length < selection.expressions.length
                  : native.columns.length !== selection.expressions.length) ||
                !Array.isArray(native.parameters) ||
                native.parameters.length !== candidate.parameterOccurrences.length
              )
                throw new MySqlContractAcquisitionError("metadata-unavailable");
              const nativeColumns = native.columns;
              const expressions = projectionExpressions(selection.expressions, nativeColumns.length);
              return {
                adapter: { id: adapterId, version: mySqlContractAdapterVersion },
                consistency: {
                  mechanism: "guarded",
                  scope: "mysql-owned-readonly-backup-locked-guarded-select-v2",
                },
                resultKind: "rows",
                columns: nativeColumns.map((column: MySqlProtocolField, index: number) => ({
                  name: column.name ?? "",
                  ...field(column, policy, false, schema, expressions[index]),
                })),
                parameters: native.parameters.map((parameter: MySqlProtocolField, index: number) => ({
                  index: index + 1,
                  ...field(parameter, policy, true, schema),
                })),
                parameterOccurrences: candidate.parameterOccurrences,
              } satisfies NativeQueryContractEvidence;
            } finally {
              await statement.close();
            }
          });
        },
        close,
      };
    } catch (error) {
      try {
        await close();
      } catch {
        throw new MySqlContractAcquisitionError("native-failure");
      }
      throw sanitized(error);
    }
  };
  const safeOpen = async (signal?: AbortSignal) => {
    const session = await protect(() => open(signal));
    return {
      context: (active?: AbortSignal) => protect(() => session.context(active)),
      describe: (candidate: NativeContractCandidate, active?: AbortSignal) =>
        protect(() => session.describe(candidate, active)),
      close: () => protect(() => session.close()),
    };
  };
  return Object.freeze<MySql2NativeContractAdapter>({
    id: adapterId,
    version: mySqlContractAdapterVersion,
    grammar: { id: "mysql", version: MYSQL_DIALECT_VERSION },
    accept(candidate) {
      try {
        select(candidate, sqlMode);
        return { accepted: true };
      } catch {
        return { accepted: false, reason: "mysql-guarded-select-scope" };
      }
    },
    open: safeOpen,
    classifyError,
    async inspectContext(signal) {
      const session = await safeOpen(signal);
      try {
        return await session.context(signal);
      } finally {
        await session.close();
      }
    },
  });
}
