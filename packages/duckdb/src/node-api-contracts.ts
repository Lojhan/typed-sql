import type * as NativeSDK from "@duckdb/node-api";
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
import { duckDBGeneratedColumns } from "./catalog/ddl.js";
import { duckDBContractAdapterVersion, duckDBContractIdentity } from "./contract-profile.js";
import { duckDBAsciiFold, formatDuckDBType, parseDuckDBType } from "./native-types.js";
import { type DuckDBSDKImporter, duckDBTypeFromSDK } from "./node-api.js";
import { duckDBParameterOccurrences, parseDuckDBStatement } from "./parser/parser.js";
import { duckDBExpressionChildren, type Expression, type Relation } from "./parser/types.js";
import { type DuckDBSchemaSnapshot, parseDuckDBSchemaSnapshot } from "./snapshot.js";
import { duckDBVersionSupport } from "./support.js";
import {
  type DuckDBTypePolicy,
  defaultDuckDBTypePolicy,
  duckDBRuntimeType,
  isKnownDuckDBType,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";

const adapterId = "@typed-sql/duckdb/node-api-contracts";
const packageName = "@duckdb/node-api";
const protect = async <Value>(work: () => Promise<Value>): Promise<Value> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DuckDBContractAcquisitionError) throw error;
    throw new DuckDBContractAcquisitionError("native-failure");
  }
};
const unknown = (reason: string) => ({ status: "unknown" as const, reason });
const known = <Value>(value: Value) => ({ status: "known" as const, value });

export class DuckDBContractAcquisitionError extends Error {
  readonly code = "DUCKDB_CONTRACT_ACQUISITION";
  constructor(readonly reason: "unsupported-context" | "unsupported-statement" | "native-failure" | "closed-session") {
    super(`DuckDB query contract acquisition failed: ${reason}`);
    this.name = "DuckDBContractAcquisitionError";
  }
}
export interface NodeDuckDBNativeContractOptions {
  /** A dedicated database file or :memory:. Each lease owns a fresh instance and connection. */
  readonly path: string;
  readonly schema: DuckDBSchemaSnapshot;
  readonly typePolicy?: DuckDBTypePolicy;
  readonly sdkImporter?: DuckDBSDKImporter;
  readonly statementTimeoutMs?: number;
}
export interface NodeDuckDBNativeContractAdapter extends NativeContractAdapter {
  inspectContext(signal?: AbortSignal): Promise<QueryContractContext>;
}

/** Admission concerns syntax and binding safety, independently of the offline result resolver. */
function selection(candidate: NativeContractCandidate): {
  readonly names: ReadonlySet<string>;
  readonly implicitNames: ReadonlySet<string>;
  readonly relations: readonly Relation[];
} {
  const parsed = candidate;
  if (typeof parsed.sql !== "string" || !parsed.sql.length || parsed.sql.length > 8 * 1024 * 1024)
    throw new DuckDBContractAcquisitionError("unsupported-statement");
  const statement = parseDuckDBStatement(parsed.sql);
  if (
    statement.kind !== "select" ||
    statement.ctes.length ||
    statement.group?.length ||
    statement.groupAll ||
    statement.having ||
    statement.qualify ||
    statement.order?.length ||
    statement.limit ||
    statement.offset ||
    statement.distinct ||
    statement.distinctOn?.length ||
    statement.windows?.length ||
    statement.set
  )
    throw new DuckDBContractAcquisitionError("unsupported-statement");
  if (
    statement.relations.some(
      (relation) =>
        !relation.name?.length ||
        relation.name.length > 3 ||
        relation.expression ||
        relation.query ||
        relation.lateral ||
        relation.ordinality ||
        relation.columns?.length,
    ) ||
    statement.projections.some(
      (projection) => projection.exclude?.length || projection.replace?.length || projection.rename?.length,
    ) ||
    (statement.where && !statement.relations.length)
  )
    throw new DuckDBContractAcquisitionError("unsupported-statement");
  const actual = duckDBParameterOccurrences(parsed.sql).map(({ index, range }) => {
    if (!/^\$[1-9]\d*$/u.test(parsed.sql.slice(range.start, range.end)))
      throw new DuckDBContractAcquisitionError("unsupported-statement");
    return { index, start: range.start, end: range.end };
  });
  if (canonicalContractData(actual) !== canonicalContractData(parsed.parameterOccurrences))
    throw new DuckDBContractAcquisitionError("unsupported-statement");
  const names = new Set<string>();
  const implicitNames = new Set<string>();
  const operatorAliases: Readonly<Record<string, readonly string[]>> = {
    "/": ["//"],
    LIKE: ["~~"],
    "NOT LIKE": ["!~~"],
    ILIKE: ["~~*"],
    "NOT ILIKE": ["!~~*"],
    "~": ["regexp_full_match"],
    "!~": ["regexp_full_match"],
    "->": ["json_extract"],
    "->>": ["json_extract_string"],
  };
  const visit = (expression: Expression): void => {
    // The engine lowers these syntax forms into catalog function bindings. A user macro
    // can otherwise hide session-dependent result types without an explicit call in our AST.
    if ((expression.kind === "unary" || expression.kind === "binary") && expression.value) {
      implicitNames.add(duckDBAsciiFold(expression.value));
      if (expression.kind === "binary")
        for (const name of operatorAliases[expression.value] ?? []) implicitNames.add(name);
    }
    if (expression.kind === "literal" && expression.literalSource?.startsWith("-")) implicitNames.add("-");
    if (expression.kind === "list") implicitNames.add("list_value");
    if (expression.kind === "struct") implicitNames.add("struct_pack");
    if (expression.kind === "tuple") implicitNames.add("row");
    if (
      expression.kind === "index" ||
      (expression.kind === "name" && (expression.left || (expression.names?.length ?? 0) > 1))
    )
      for (const name of [
        "array_extract",
        "array_slice",
        "struct_extract",
        "struct_extract_at",
        "map_extract_value",
        "union_extract",
        "json_extract",
        "variant_extract",
      ])
        implicitNames.add(name);

    if (
      ![
        "literal",
        "parameter",
        "cast",
        "call",
        "unary",
        "binary",
        "case",
        "list",
        "struct",
        "tuple",
        "index",
        ...(statement.relations.length ? ["name", "star"] : []),
      ].includes(expression.kind)
    )
      throw new DuckDBContractAcquisitionError("unsupported-statement");
    if (
      expression.kind === "cast" &&
      (!expression.nativeType || !isKnownDuckDBType(parseDuckDBType(expression.nativeType)))
    )
      throw new DuckDBContractAcquisitionError("unsupported-statement");
    if (expression.kind === "call") {
      if (
        expression.names?.length !== 1 ||
        expression.filter ||
        expression.window ||
        expression.distinct ||
        expression.context?.length ||
        expression.argumentNames?.some((name) => name !== undefined)
      )
        throw new DuckDBContractAcquisitionError("unsupported-statement");
      names.add(duckDBAsciiFold(expression.names[0]!));
    }
    for (const child of duckDBExpressionChildren(expression)) visit(child);
  };
  for (const projection of statement.projections) visit(projection.expression);
  if (statement.where) visit(statement.where);
  for (const relation of statement.relations) if (relation.condition) visit(relation.condition);
  return { names, implicitNames, relations: statement.relations };
}

/** Native PREPARE metadata only: candidate SQL is never bound, executed or sampled. */
export function createNodeDuckDBNativeContractAdapter(
  options: NodeDuckDBNativeContractOptions,
): NodeDuckDBNativeContractAdapter {
  const schema = parseDuckDBSchemaSnapshot(options.schema);
  const policy = validateDuckDBTypePolicy(options.typePolicy ?? defaultDuckDBTypePolicy);
  const path = options.path;
  const importer = options.sdkImporter;
  const timeout = options.statementTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
    throw new RangeError("DuckDB description timeout must be 1..60000 ms");
  if (typeof path !== "string" || !path.length || path.includes("\0"))
    throw new TypeError("Invalid DuckDB database path");
  const open = async (signal?: AbortSignal): Promise<NativeContractSession> => {
    signal?.throwIfAborted();
    const imported = await (importer?.() ?? import(packageName));
    // The same checked SDK owns every instance, prepared handle and logical type.
    duckDBTypeFromSDK((imported as typeof NativeSDK).INTEGER, imported);
    const sdk = imported as typeof NativeSDK;
    if (duckDBVersionSupport(sdk.version()) !== "supported")
      throw new DuckDBContractAcquisitionError("unsupported-context");
    const instance = await sdk.DuckDBInstance.create(path, {
      enable_external_access: "false",
      autoload_known_extensions: "false",
      autoinstall_known_extensions: "false",
      ...(path === ":memory:" ? {} : { access_mode: "READ_ONLY" }),
    });
    let connection: NativeSDK.DuckDBConnection | undefined;
    let closed = false,
      described = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupt = () => {
      try {
        connection?.interrupt();
      } catch {}
    };
    const requireOpen = (active?: AbortSignal) => {
      if (closed || !connection) throw new DuckDBContractAcquisitionError("closed-session");
      signal?.throwIfAborted();
      active?.throwIfAborted();
      if (expired) throw new DuckDBContractAcquisitionError("native-failure");
      return connection;
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", interrupt);
      try {
        if (connection) {
          const result = await connection.run("ROLLBACK");
          result.closeSync();
        }
      } finally {
        try {
          connection?.closeSync();
        } finally {
          instance.closeSync();
        }
      }
    };
    const read = async (sql: string) => {
      const result = await requireOpen().run(sql);
      try {
        return await result.getRows();
      } finally {
        result.closeSync();
      }
    };
    let routines: readonly (readonly NativeSDK.DuckDBValue[])[] = [];
    let types: readonly (readonly NativeSDK.DuckDBValue[])[] = [];
    let relations: readonly (readonly NativeSDK.DuckDBValue[])[] = [];
    let columns: readonly (readonly NativeSDK.DuckDBValue[])[] = [];
    let binding: readonly NativeSDK.DuckDBValue[] = [];
    try {
      connection = await instance.connect();
      signal?.addEventListener("abort", interrupt, { once: true });
      timer = setTimeout(() => {
        expired = true;
        interrupt();
      }, timeout);
      timer.unref();
      // Prevent constant folding from invoking candidate scalar functions during planning.
      await read("PRAGMA disable_optimizer");
      await read("BEGIN TRANSACTION READ ONLY");
      const version = await read("SELECT library_version FROM system.main.pragma_version()");
      if (version[0]?.[0] !== sdk.version()) throw new DuckDBContractAcquisitionError("unsupported-context");
      routines = await read(
        "SELECT database_name,schema_name,function_name,function_type,internal,has_side_effects,stability,parameter_types::VARCHAR,return_type,varargs,macro_definition FROM system.main.duckdb_functions() ORDER BY ALL LIMIT 20001",
      );
      types = await read(
        "SELECT database_name,schema_name,type_name,type_oid::VARCHAR,logical_type,labels::VARCHAR FROM system.main.duckdb_types() ORDER BY ALL LIMIT 20001",
      );
      binding = (await read("SELECT current_database(),current_schema(),current_setting('search_path')"))[0] ?? [];
      if (typeof binding[0] !== "string" || typeof binding[1] !== "string" || binding[2] !== "")
        throw new DuckDBContractAcquisitionError("unsupported-context");
      relations = await read(
        "SELECT database_name,schema_name,table_name,'table' AS kind,temporary,sql FROM system.main.duckdb_tables() WHERE NOT internal UNION ALL SELECT database_name,schema_name,view_name,'view' AS kind,temporary,sql FROM system.main.duckdb_views() WHERE NOT internal ORDER BY ALL LIMIT 20001",
      );
      columns = await read(
        "SELECT database_name,schema_name,table_name,column_name,column_index,data_type,is_nullable,column_default FROM system.main.duckdb_columns() WHERE NOT internal ORDER BY ALL LIMIT 65537",
      );
      if (relations.length > 20000 || columns.length > 65536)
        throw new DuckDBContractAcquisitionError("unsupported-context");
      if (routines.length > 20000 || types.length > 20000)
        throw new DuckDBContractAcquisitionError("unsupported-context");
      signal?.throwIfAborted();
    } catch (error) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "DuckDB acquisition and cleanup failed");
      }
      throw error;
    }
    const context = async (contextSignal?: AbortSignal): Promise<QueryContractContext> => {
      requireOpen(contextSignal);
      const settings = await read("SELECT name,value FROM system.main.duckdb_settings() ORDER BY name");
      const values = new Map(settings.map(([name, value]) => [String(name), value]));
      for (const name of ["enable_external_access", "autoload_known_extensions", "autoinstall_known_extensions"])
        if (values.get(name) !== "false") throw new DuckDBContractAcquisitionError("unsupported-context");
      if (
        values.get("enable_optimizer") !== "false" &&
        !(sdk.version() === "v1.5.6" && !values.has("enable_optimizer"))
      )
        throw new DuckDBContractAcquisitionError("unsupported-context");
      contextSignal?.throwIfAborted();
      return {
        grammar: { id: "duckdb", version: DUCKDB_DIALECT_VERSION },
        ...duckDBContractIdentity(policy),
        schemaHash: calculateSchemaHash(schema),
        typePolicyHash: calculateTypePolicyHash(policy),
        databaseContextHash: queryContractDigest({
          version: sdk.version(),
          routines,
          types,
          relations,
          columns,
          binding,
          settings,
        }),
      };
    };
    return {
      context: (active) => protect(() => context(active)),
      describe: (candidate, describeSignal) =>
        protect(async () => {
          const current = requireOpen(describeSignal);
          if (described) throw new DuckDBContractAcquisitionError("unsupported-statement");
          described = true;
          const selected = selection(candidate);
          for (const relation of selected.relations) {
            const parts = relation.name!;
            const catalog = parts.length === 3 ? parts[0]! : String(binding[0]);
            const namespace = parts.length >= 2 ? parts[parts.length - 2]! : String(binding[1]);
            const name = parts.at(-1)!;
            if (duckDBAsciiFold(catalog) !== duckDBAsciiFold(String(binding[0])))
              throw new DuckDBContractAcquisitionError("unsupported-statement");
            const matches = (row: readonly NativeSDK.DuckDBValue[]) =>
              typeof row[0] === "string" &&
              typeof row[1] === "string" &&
              typeof row[2] === "string" &&
              duckDBAsciiFold(row[0]) === duckDBAsciiFold(catalog) &&
              duckDBAsciiFold(row[1]) === duckDBAsciiFold(namespace) &&
              duckDBAsciiFold(row[2]) === duckDBAsciiFold(name);
            const tables = relations.filter(matches),
              table = tables[0],
              fields = columns.filter(matches);
            if (
              tables.length !== 1 ||
              table?.[3] !== "table" ||
              table[4] !== false ||
              typeof table[5] !== "string" ||
              !fields.length
            )
              throw new DuckDBContractAcquisitionError("unsupported-statement");
            const declarations = duckDBGeneratedColumns(table[5]);
            if (
              declarations.size !== fields.length ||
              fields.some(
                (field) =>
                  typeof field[3] !== "string" ||
                  typeof field[5] !== "string" ||
                  declarations.get(duckDBAsciiFold(field[3]))?.generated !== false ||
                  !isKnownDuckDBType(parseDuckDBType(field[5])),
              )
            )
              throw new DuckDBContractAcquisitionError("unsupported-statement");
          }
          for (const name of selected.implicitNames) {
            if (
              routines.some(
                (row) =>
                  typeof row[2] === "string" &&
                  duckDBAsciiFold(row[2]) === name &&
                  (row[0] !== "system" || row[1] !== "main" || row[4] !== true),
              )
            )
              throw new DuckDBContractAcquisitionError("unsupported-statement");
          }
          for (const name of selected.names) {
            // DuckDB 1.5.6 labels getvariable CONSISTENT even though its bound
            // result type depends on connection-local variables outside this context.
            if (name === "getvariable") throw new DuckDBContractAcquisitionError("unsupported-statement");
            const family = routines.filter((row) => typeof row[2] === "string" && duckDBAsciiFold(row[2]) === name);
            if (
              !family.length ||
              family.some(
                (row) =>
                  row[0] !== "system" ||
                  row[1] !== "main" ||
                  row[3] !== "scalar" ||
                  row[4] !== true ||
                  row[5] !== false ||
                  row[6] !== "CONSISTENT",
              )
            )
              throw new DuckDBContractAcquisitionError("unsupported-statement");
          }
          const native = await current.prepare(candidate.sql);
          try {
            requireOpen(describeSignal);
            const field = (type: NativeSDK.DuckDBType | undefined): NativeContractValueEvidence => {
              if (!type || type.typeId === sdk.DuckDBTypeId.ANY)
                return {
                  nativeType: unknown("unresolved-native-type"),
                  runtimeType: unknown("unresolved-native-type"),
                  nullable: unknown("prepare-has-no-nullability"),
                  descriptor: {},
                };
              const logical = duckDBTypeFromSDK(type, sdk),
                name = formatDuckDBType(logical);
              return {
                nativeType: known({ name, complete: isKnownDuckDBType(logical) }),
                runtimeType: isKnownDuckDBType(logical)
                  ? known(duckDBRuntimeType(logical, policy))
                  : unknown("unqualified-logical-type"),
                nullable: unknown("prepare-has-no-nullability"),
                descriptor: { logicalType: logical },
              };
            };
            const evidence: NativeQueryContractEvidence = {
              adapter: { id: adapterId, version: duckDBContractAdapterVersion },
              consistency: {
                mechanism: "snapshot",
                scope:
                  "duckdb-owned-readonly-catalog-snapshot-external-access-and-optimizer-disabled-guarded-select-v3",
              },
              resultKind: "rows",
              columns: Array.from({ length: native.columnCount }, (_, i) => ({
                name: native.columnName(i),
                ...field(native.columnTypeId(i) === sdk.DuckDBTypeId.INVALID ? undefined : native.columnType(i)),
              })),
              parameters: Array.from({ length: native.parameterCount }, (_, i) => ({
                index: i + 1,
                ...field(
                  native.parameterTypeId(i + 1) === sdk.DuckDBTypeId.INVALID ? undefined : native.parameterType(i + 1),
                ),
              })),
              parameterOccurrences: candidate.parameterOccurrences,
            };
            return evidence;
          } finally {
            native.destroySync();
          }
        }),
      close: () => protect(close),
    };
  };
  return Object.freeze({
    id: adapterId,
    version: duckDBContractAdapterVersion,
    grammar: { id: "duckdb", version: DUCKDB_DIALECT_VERSION },
    classifyError(error: unknown): LiveAnalysisFailure {
      if (error instanceof DuckDBContractAcquisitionError && error.reason.startsWith("unsupported-"))
        return { kind: "partial", code: `duckdb-${error.reason}` };
      return { kind: "unavailable", code: "duckdb-native-failure", retry: "change" };
    },
    accept(candidate: NativeContractCandidate) {
      try {
        selection(candidate);
        return { accepted: true as const };
      } catch {
        return { accepted: false as const, reason: "duckdb-guarded-select-scope" };
      }
    },
    open: (signal?: AbortSignal) => protect(() => open(signal)),
    async inspectContext(signal?: AbortSignal) {
      const session = await protect(() => open(signal));
      try {
        return await session.context(signal);
      } finally {
        await session.close();
      }
    },
  });
}
