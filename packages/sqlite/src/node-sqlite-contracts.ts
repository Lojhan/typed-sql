import { fork } from "node:child_process";
import { resolve } from "node:path";
import {
  canonicalContractData,
  type LiveAnalysisFailure,
  type NativeContractAdapter,
  type NativeContractCandidate,
  type NativeContractSession,
  type NativeContractValueEvidence,
  type NativeQueryContractEvidence,
  type QueryContractContext,
} from "@typed-sql/analysis";
import type { RuntimeValueType } from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { sqliteContractAdapterVersion, sqliteContractIdentity, sqliteContractPolicy } from "./contract-profile.js";
import { tokenize } from "./parser/tokenizer.js";
import { parseSqliteSchemaSnapshot, type SqliteSchemaSnapshot } from "./snapshot.js";
import type { SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

const adapterId = "@typed-sql/sqlite/node-sqlite-contracts";
export class SqliteContractAcquisitionError extends Error {
  readonly code = "SQLITE_CONTRACT_ACQUISITION";
  constructor(
    readonly reason:
      | "unsupported-context"
      | "unsupported-statement"
      | "native-rejected"
      | "native-failure"
      | "closed-session"
      | "deadline",
  ) {
    super(`SQLite query contract acquisition failed: ${reason}`);
    this.name = "SqliteContractAcquisitionError";
  }
}
export interface NodeSqliteNativeContractOptions {
  /** A persistent file. Acquisition owns a separate read-only connection in a bounded worker. */
  readonly path: string;
  readonly schema: SqliteSchemaSnapshot;
  readonly typePolicy?: SqliteTypePolicy;
  readonly statementTimeoutMs?: number;
}
export interface NodeSqliteNativeContractAdapter extends NativeContractAdapter {
  inspectContext(signal?: AbortSignal): Promise<QueryContractContext>;
}
function admission(input: NativeContractCandidate): NativeContractCandidate {
  const candidate = JSON.parse(canonicalContractData(input)) as NativeContractCandidate;
  if (!candidate || typeof candidate.sql !== "string" || !Array.isArray(candidate.parameterOccurrences))
    throw new SqliteContractAcquisitionError("unsupported-statement");
  const tokens = tokenize(candidate.sql);
  const meaningful = tokens.filter((token) => token.kind !== "eof");
  if (!meaningful.length || !["SELECT", "WITH", "VALUES"].includes(meaningful[0]!.text.toUpperCase()))
    throw new SqliteContractAcquisitionError("unsupported-statement");
  if (meaningful.some((token, index) => token.text === ";" && index !== meaningful.length - 1))
    throw new SqliteContractAcquisitionError("unsupported-statement");
  const parameters = meaningful.filter((token) => token.kind === "parameter");
  if (
    parameters.some((token) => token.text !== "?" || /[0-9]/u.test(candidate.sql[token.range.end] ?? "")) ||
    canonicalContractData(
      parameters.map((token, index) => ({ index: index + 1, start: token.range.start, end: token.range.end })),
    ) !== canonicalContractData(candidate.parameterOccurrences)
  )
    throw new SqliteContractAcquisitionError("unsupported-statement");
  return candidate;
}
/** Read-only native acceptance/labels and conservative SQLite storage domains, without evaluation. */
export function createNodeSqliteNativeContractAdapter(
  options: NodeSqliteNativeContractOptions,
): NodeSqliteNativeContractAdapter {
  const schema = parseSqliteSchemaSnapshot(JSON.parse(canonicalContractData(options.schema)));
  const policy = sqliteContractPolicy(options.typePolicy);
  if (
    typeof options.path !== "string" ||
    !options.path.length ||
    options.path.includes("\0") ||
    options.path === ":memory:" ||
    options.path.startsWith("file:")
  )
    throw new TypeError("SQLite native contracts require a database file");
  const path = resolve(options.path);
  const timeout = options.statementTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw new RangeError("Invalid SQLite native deadline");
  const identity = sqliteContractIdentity(policy);
  const runtime: RuntimeValueType =
    policy.flexible === "unknown"
      ? "unknown"
      : Object.freeze({
          union: Object.freeze([...new Set<RuntimeValueType>([policy.integer, "number", "string", "bytes"])]),
        });
  const fact = (descriptor: Readonly<Record<string, unknown>>, parameter = false): NativeContractValueEvidence => ({
    nativeType: { status: "known", value: { name: "sqlite-storage-class", complete: false } },
    runtimeType: {
      status: "known",
      value:
        parameter && typeof runtime === "object" && "union" in runtime
          ? { union: [...runtime.union, "boolean"] }
          : runtime,
    },
    nullable: { status: "known", value: true, precision: "upper-bound" },
    descriptor,
  });
  const context = (databaseContextHash: string): QueryContractContext =>
    Object.freeze({
      grammar: Object.freeze({ id: "sqlite", version: SQLITE_DIALECT_VERSION }),
      ...identity,
      schemaHash: calculateSchemaHash(schema),
      typePolicyHash: calculateTypePolicyHash(policy),
      databaseContextHash,
    });
  const open = async (signal?: AbortSignal): Promise<NativeContractSession> => {
    signal?.throwIfAborted();
    const { NODE_OPTIONS: _nodeOptions, NODE_PATH: _nodePath, ...environment } = process.env;
    const worker = fork(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist/packages/sqlite/src/node-sqlite-contract-worker.js"
          : "./node-sqlite-contract-worker.js",
        import.meta.url,
      ),
      [path],
      {
        execArgv: ["--max-old-space-size=64"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        env: environment,
      },
    );
    let closed = false,
      busy = false;
    let failed: (error: unknown) => void = () => {};
    const exited = new Promise<void>((done) => worker.once("exit", () => done()));
    let termination: Promise<void> | undefined;
    const terminate = (graceful = false) =>
      (termination ??= (async () => {
        closed = true;
        failed(new SqliteContractAcquisitionError("closed-session"));
        if (worker.exitCode !== null || worker.signalCode !== null) return;
        const timer = setTimeout(() => worker.kill("SIGKILL"), 100);
        if (graceful && !busy && worker.connected) worker.send({ kind: "close" });
        else worker.kill("SIGKILL");
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      })());
    worker.on("error", () => {
      failed(new SqliteContractAcquisitionError("native-failure"));
      void terminate();
    });
    worker.on("exit", () => {
      if (!closed) {
        closed = true;
        failed(new SqliteContractAcquisitionError("native-failure"));
      }
    });
    const exchange = async (message?: unknown, active?: AbortSignal): Promise<Record<string, unknown>> => {
      if (closed) throw new SqliteContractAcquisitionError("closed-session");
      if (busy) throw new SqliteContractAcquisitionError("unsupported-context");
      busy = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise((done, reject) => {
          const finish = (error?: unknown, value?: Record<string, unknown>) => {
            clearTimeout(timer);
            active?.removeEventListener("abort", aborted);
            worker.off("message", receive);
            failed = () => {};
            if (error) reject(error);
            else done(value!);
          };
          const aborted = () => finish(active?.reason ?? new SqliteContractAcquisitionError("native-failure"));
          const receive = (value: Record<string, unknown>) =>
            value.kind === "error"
              ? finish(
                  new SqliteContractAcquisitionError(
                    value.reason === "native-rejected"
                      ? "native-rejected"
                      : value.reason === "unsupported-context"
                        ? "unsupported-context"
                        : "native-failure",
                  ),
                )
              : finish(undefined, value);
          failed = (error) => finish(error);
          worker.once("message", receive);
          timer = setTimeout(() => finish(new SqliteContractAcquisitionError("deadline")), timeout);
          active?.addEventListener("abort", aborted, { once: true });
          if (active?.aborted) aborted();
          else if (message) worker.send(message as object);
        });
      } catch (error) {
        await terminate();
        throw error;
      } finally {
        busy = false;
      }
    };
    const ready = await exchange(undefined, signal);
    if (
      ready.kind !== "ready" ||
      typeof ready.scope !== "string" ||
      !/^[a-f0-9]{64}$/u.test(ready.scope) ||
      typeof ready.version !== "string"
    ) {
      await terminate();
      throw new SqliteContractAcquisitionError("native-failure");
    }
    const selected = context(ready.scope);
    let described = false;
    return {
      async context(active) {
        active?.throwIfAborted();
        if (closed) throw new SqliteContractAcquisitionError("closed-session");
        return selected;
      },
      async describe(input, active): Promise<NativeQueryContractEvidence> {
        active?.throwIfAborted();
        if (closed) throw new SqliteContractAcquisitionError("closed-session");
        const candidate = admission(input);
        if (described) throw new SqliteContractAcquisitionError("unsupported-context");
        described = true;
        const result = await exchange({ kind: "describe", sql: candidate.sql }, active);
        if (result.kind !== "described" || !Array.isArray(result.columns))
          throw new SqliteContractAcquisitionError("native-failure");
        return {
          adapter: { id: adapterId, version: sqliteContractAdapterVersion },
          consistency: { mechanism: "snapshot", scope: ready.scope as string },
          resultKind: "rows",
          columns: result.columns.map((column) => ({
            ...fact({ origin: column, sqliteVersion: ready.version }),
            name: column.name,
          })),
          parameters: candidate.parameterOccurrences.map(({ index }) => ({
            ...fact({ binding: "anonymous-sqlite-value", sqliteVersion: ready.version }, true),
            index,
          })),
          parameterOccurrences: candidate.parameterOccurrences,
        };
      },
      async close() {
        await terminate(true);
      },
    };
  };
  return Object.freeze<NodeSqliteNativeContractAdapter>({
    id: adapterId,
    version: sqliteContractAdapterVersion,
    grammar: { id: "sqlite", version: SQLITE_DIALECT_VERSION },
    accept(candidate) {
      try {
        admission(candidate);
        return { accepted: true as const };
      } catch {
        return { accepted: false as const, reason: "unsupported-statement" };
      }
    },
    classifyError(error): LiveAnalysisFailure {
      if (error instanceof SqliteContractAcquisitionError && error.reason === "native-rejected")
        return { kind: "rejected", code: "sqlite-native-rejected" };
      if (
        error instanceof SqliteContractAcquisitionError &&
        ["unsupported-context", "unsupported-statement", "closed-session"].includes(error.reason)
      )
        return { kind: "unavailable", code: "sqlite-native-profile-unavailable", retry: "change" };
      return { kind: "unavailable", code: "sqlite-native-unavailable", retry: "transport" };
    },
    open,
    async inspectContext(signal) {
      const session = await open(signal);
      let observed: QueryContractContext;
      try {
        observed = await session.context(signal);
      } finally {
        await session.close();
      }
      signal?.throwIfAborted();
      return observed;
    },
  });
}
