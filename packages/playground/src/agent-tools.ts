import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { z } from "zod/v4";
import { presentationSchema } from "./analysis-contract.js";
import type { AnalysisStore } from "./analysis-store.js";
import type { PlaygroundTarget, PlaygroundTargetConfig } from "./contracts.js";
import type { ExplorerResponse } from "./explorer-types.js";
import { contentHash, WorkspaceError, type WorkspaceFiles } from "./files.js";
import type { RunManager } from "./runner.js";
import { analyzeSql, bindSql } from "./sql.js";
import { decodeValue, encodeValue, type WireValue } from "./values.js";

interface ProposalInput {
  readonly file: string;
  readonly source: string;
  readonly revision: string | null;
  readonly description?: string;
}
interface Turn {
  readonly conversationId: string;
  readonly controller: AbortController;
  readonly propose: (input: ProposalInput) => Promise<unknown>;
  readonly requests: Set<McpServer>;
  readonly responses: Set<ServerResponse>;
  readonly onToolCall?:
    | ((event: {
        id: string;
        name: string;
        state: "running" | "completed" | "failed";
        details?: string;
        input?: string;
      }) => void | Promise<void>)
    | undefined;
  calls: number;
  busy: number;
}
export interface WorkspaceToolsOptions {
  readonly analyses?: AnalysisStore;
  readonly targetName?: string;
  readonly files: WorkspaceFiles;
  readonly trusted: () => boolean;
  readonly origin: () => string;
  readonly dialect: DialectPlugin;
  readonly prepare?: (
    source: string,
  ) => Promise<{ dialect: DialectPlugin; schema: SchemaSnapshot; assertCurrent(): Promise<void> }>;
  readonly typePolicy: unknown;
  readonly schema: () => SchemaSnapshot;
  readonly schemaSource?: () => string;
  readonly target?: Omit<PlaygroundTargetConfig, "connect"> & { readonly connect: () => unknown };
  readonly explorer: () => Promise<ExplorerResponse>;
  readonly runs: Pick<RunManager, "list" | "page">;
}
const maximum = 64 * 1024;
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const limit = z.number().int().min(1).max(50).default(20);
const file = z.string().min(1).max(4096);
const sql = z
  .string()
  .min(1)
  .max(32 * 1024);
const values = z.array(z.unknown()).max(50).default([]);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
function result(value: Record<string, unknown>) {
  // Budget nested objects before JSON serialization allocates the response string.
  encodeValue(value, { maxBytes: maximum - 8192, maxNodes: 10000 });
  const text = JSON.stringify(value);
  if (Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }], structuredContent: value })) > maximum)
    throw new WorkspaceError("AGENT_TOOL_LIMIT", "Tool response exceeds 64 KiB; request a smaller page or file range");
  return { content: [{ type: "text" as const, text }], structuredContent: value };
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new WorkspaceError("AGENT_TOOL_CANCELLED", "Tool operation was cancelled or exceeded five seconds"));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
    if (signal.aborted) abort();
  });
}
function page<T>(items: readonly T[], start: number, count: number) {
  return {
    items: items.slice(start, start + count),
    offset: start,
    nextOffset: start + count < items.length ? start + count : null,
    total: items.length,
  };
}

/** Explicit per-turn capability. This endpoint never accepts the ordinary browser session token. */
export class AgentWorkspaceToolServer {
  private readonly turns = new Map<string, Turn>();
  constructor(private readonly options: WorkspaceToolsOptions) {}
  async open(input: {
    conversationId: string;
    propose: (input: ProposalInput) => Promise<unknown>;
    signal: AbortSignal;
    onToolCall?: (event: {
      id: string;
      name: string;
      state: "running" | "completed" | "failed";
      details?: string;
      input?: string;
    }) => void | Promise<void>;
  }) {
    if (!this.options.trusted() || input.signal.aborted)
      throw new WorkspaceError("TRUST", "Enable trusted project execution before sharing workspace tools", 403);
    const token = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    const turn: Turn = {
      controller,
      conversationId: input.conversationId,
      propose: input.propose,
      requests: new Set(),
      responses: new Set(),
      onToolCall: input.onToolCall,
      calls: 0,
      busy: 0,
    };
    this.turns.set(token, turn);
    const close = async () => {
      this.turns.delete(token);
      controller.abort();
      for (const response of turn.responses) response.destroy();
      input.signal.removeEventListener("abort", abort);
      await Promise.allSettled([...turn.requests].map((server) => server.close()));
    };
    const abort = () => {
      void close();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) await close();
    return {
      mcpServers: [
        {
          type: "http" as const,
          name: `typed-sql-${randomBytes(6).toString("hex")}`,
          url: `${this.options.origin()}/api/agent-tools`,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        },
      ],
      close,
    };
  }
  async close() {
    const turns = [...this.turns.values()];
    this.turns.clear();
    for (const turn of turns) {
      turn.controller.abort();
      for (const response of turn.responses) response.destroy();
    }
    await Promise.allSettled(turns.flatMap((turn) => [...turn.requests].map((server) => server.close())));
  }
  async handle(request: IncomingMessage, response: ServerResponse, _url: URL, body: unknown): Promise<void> {
    const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "",
      turn = this.turns.get(token);
    if (!turn || turn.controller.signal.aborted || !this.options.trusted())
      throw new WorkspaceError("AGENT_TOOL_TOKEN", "Workspace tool capability is missing, expired or revoked", 403);
    if (request.method !== "POST")
      throw new WorkspaceError("METHOD", "Workspace tools use MCP JSON POST requests", 405);
    if (turn.busy >= 2 || ++turn.calls > 100)
      throw new WorkspaceError("AGENT_TOOL_LIMIT", "Workspace tool request limit reached", 429);
    const server = this.server(turn),
      transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    turn.requests.add(server);
    turn.responses.add(response);
    turn.busy++;
    const disconnected = () => {
      if (!response.writableEnded) void server.close();
    };
    response.on("close", disconnected);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      response.off("close", disconnected);
      turn.busy--;
      turn.requests.delete(server);
      turn.responses.delete(response);
      await server.close();
    }
  }
  private server(turn: Turn): McpServer {
    const server = new McpServer({ name: "typed-sql-workspace", version: "1.0.0" });
    const register = <Shape extends z.ZodRawShape>(
      name: string,
      description: string,
      shape: Shape,
      fn: (input: z.infer<z.ZodObject<Shape>>, signal: AbortSignal) => Promise<Record<string, unknown>>,
      readOnly = true,
    ) => {
      server.registerTool(
        name,
        {
          description,
          inputSchema: z.object(shape).strict(),
          outputSchema: z.record(z.string(), z.unknown()),
          annotations: { ...annotations, readOnlyHint: readOnly, idempotentHint: readOnly },
        },
        async (input, context) => {
          const id = randomUUID();
          try {
            await turn.onToolCall?.({
              id,
              name,
              state: "running",
              input: JSON.stringify(input, null, 2).slice(0, 65536),
            });
            if (!this.options.trusted() || turn.controller.signal.aborted)
              throw new WorkspaceError("TRUST", "Workspace tool capability has been revoked", 403);
            const signal = AbortSignal.any([turn.controller.signal, context.mcpReq.signal, AbortSignal.timeout(5000)]);
            const value = await bounded(fn(input as z.infer<z.ZodObject<Shape>>, signal), signal);
            signal.throwIfAborted();
            if (!this.options.trusted())
              throw new WorkspaceError("TRUST", "Workspace tool capability has been revoked", 403);
            const response = result(value);
            await turn.onToolCall?.({
              id,
              name,
              state: "completed",
              details:
                JSON.stringify(value, null, 2).length > 8192
                  ? `${JSON.stringify(value, null, 2).slice(0, 8100)}\n… (details truncated; inspect captured data for complete values)`
                  : JSON.stringify(value, null, 2),
            });
            return response;
          } catch (error) {
            await Promise.resolve(turn.onToolCall?.({ id, name, state: "failed" })).catch(() => {});
            const candidate = error && typeof error === "object" ? error : undefined;
            const code = candidate && "code" in candidate ? candidate.code : undefined;
            const state = candidate && "sqlState" in candidate ? candidate.sqlState : undefined;
            const sqlState = typeof state === "string" && /^[A-Z0-9]{5}$/u.test(state) ? state : undefined;
            if (code === "TSQL_PLAYGROUND_READ_ONLY" || sqlState === "25006") {
              const message =
                sqlState === "25006"
                  ? "The database rejected a write in the enforced read-only transaction (SQLSTATE 25006). Propose file changes for human review instead."
                  : "The managed adapter blocked write execution. Agent query tools only allow database-enforced read-only queries; propose file changes for human review instead.";
              return {
                isError: true,
                content: [{ type: "text" as const, text: message }],
                structuredContent: {
                  error: {
                    code: "READ_ONLY",
                    enforcement: sqlState === "25006" ? "database" : "adapter",
                    ...(sqlState ? { sqlState } : {}),
                  },
                },
              };
            }
            if (sqlState)
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: `Database rejected the query (SQLSTATE ${sqlState}). Check the SQL, parameter types and target schema.`,
                  },
                ],
                structuredContent: { error: { code: "DATABASE", sqlState } },
              };
            if (code === "TSQL_PLAYGROUND_SQL_MODE")
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: "Agent queries do not allow transaction, session or COPY commands. Use one checked read-only statement.",
                  },
                ],
                structuredContent: { error: { code: "SQL_MODE" } },
              };
            const message =
              error instanceof WorkspaceError
                ? error.message
                : error instanceof RangeError
                  ? "Response too large; request a smaller page or file range"
                  : "Tool operation failed or was cancelled; inspect the workspace and retry explicitly";
            return { isError: true, content: [{ type: "text" as const, text: message }] };
          }
        },
      );
    };
    register(
      "typed_sql_get_schema",
      "List captured schema objects and relationships, with source identity. Uses the workspace snapshot; never refreshes or connects.",
      { offset, limit },
      async (input) => {
        const data = await this.options.explorer();
        return {
          schemaHash: data.schema.schemaHash,
          source: data.schema.source,
          capturedAt: data.schema.capturedAt,
          coverage: data.schema.coverage,
          ...page(
            data.schema.objects.map(({ id, kind, namespace, name, parentId }) => ({
              id,
              kind,
              namespace,
              name,
              parentId,
            })),
            input.offset,
            input.limit,
          ),
        };
      },
    );
    register(
      "typed_sql_get_object",
      "Read one captured schema object's definition, relationships and historical evidence. Use an id returned by get_schema.",
      { id: z.string().max(4096), historyOffset: offset, historyLimit: limit, linkOffset: offset },
      async (input) => {
        const data = await this.options.explorer(),
          object = data.schema.objects.find((item) => item.id === input.id);
        if (!object) throw new WorkspaceError("OBJECT", "Captured object not found", 404);
        return {
          schemaHash: data.schema.schemaHash,
          source: data.schema.source,
          object: {
            ...object,
            history: object.history.slice(input.historyOffset, input.historyOffset + input.historyLimit),
          },
          historyPagination: page(
            object.history.map(({ attemptId }) => attemptId),
            input.historyOffset,
            input.historyLimit,
          ),
          links: page(
            data.schema.links.filter((link) => link.source === input.id || link.target === input.id),
            input.linkOffset,
            50,
          ),
        };
      },
    );
    register(
      "typed_sql_list_migrations",
      "List captured applied/pending migration summaries. No migrations are executed or refreshed.",
      { offset, limit },
      async (input) => {
        const data = await this.options.explorer();
        return {
          state: data.migrations.state,
          message: data.migrations.message,
          ...page(
            data.migrations.entries.map(({ attempts, ...migration }) => {
              const last = attempts.at(-1);
              return {
                ...migration,
                attemptCount: attempts.length,
                ...(last
                  ? {
                      latestAttempt: {
                        attemptId: last.attemptId,
                        direction: last.direction,
                        state: last.state,
                        origin: last.origin,
                        evidence: last.evidence,
                        startedAt: last.startedAt,
                        finishedAt: last.finishedAt,
                        changeCount: last.changes?.length ?? 0,
                      },
                    }
                  : {}),
              };
            }),
            input.offset,
            input.limit,
          ),
        };
      },
    );
    register(
      "typed_sql_list_files",
      "List actual project files within configured read/write roots; page through paths before reading.",
      { offset, limit },
      async (input) => page(await this.options.files.list(), input.offset, input.limit),
    );
    register(
      "typed_sql_read_file",
      "Read saved source lines and revision from an allowed project file. This does not include unsaved browser buffers.",
      {
        file,
        line: z.number().int().min(1).max(1000000).default(1),
        limit: z.number().int().min(1).max(200).default(100),
      },
      async (input) => {
        const current = await this.options.files.read(input.file),
          lines = current.source.split(/\r?\n/u),
          start = input.line - 1;
        return {
          file: input.file,
          revision: current.revision,
          line: input.line,
          totalLines: lines.length,
          nextLine: start + input.limit < lines.length ? start + input.limit + 1 : null,
          source: lines.slice(start, start + input.limit).join("\n"),
        };
      },
    );
    register(
      "typed_sql_analyze_sql",
      "Analyze SQL against the captured schema and selected grammar/type policy without executing. Unknown/unsupported SQL remains diagnostic.",
      { sql },
      async (input) => {
        const prepared = await this.options.prepare?.(input.sql);
        const snapshot = prepared?.schema ?? this.options.schema(),
          analysis = analyzeSql(
            input.sql,
            prepared?.dialect ?? this.options.dialect,
            snapshot,
            this.options.typePolicy,
          );
        await prepared?.assertCurrent();
        return {
          schemaHash: calculateSchemaHash(this.options.schema()),
          diagnostics: analysis.compiled.sourceDiagnostics,
          parameters: analysis.parameters,
          query: analysis.compiled.query ?? null,
        };
      },
    );
    register(
      "typed_sql_query_readonly",
      "Execute checked SQL on the explicit configured target in database-enforced read-only mode. At most 50 rows/64 KiB/5 seconds; returns lossless tagged values and truncation. No TS, writes or schema refresh.",
      { sql, values },
      async (input, signal) => this.query(input.sql, input.values as WireValue[], signal),
    );
    register(
      "typed_sql_get_result",
      "Read an already captured query result page, without advancing a live cursor. Omit runId to discover retained run/result identities.",
      {
        runId: z.string().max(100).optional(),
        resultId: z.string().max(100).optional(),
        page: z.number().int().min(0).max(100000).default(0),
      },
      async (input) => {
        const runs = this.options.runs.list();
        if (!input.runId)
          return {
            runs: runs.map(({ id, file, sourceRevision, target, status, results }) => ({
              id,
              file,
              sourceRevision,
              target,
              status,
              results: results.map(({ paging }) => paging),
            })),
          };
        const run = runs.find((item) => item.id === input.runId),
          event = run?.results.find((item) => item.paging?.id === input.resultId);
        if (!run || !event?.paging || input.page >= event.paging.pageCount)
          throw new WorkspaceError(
            "RESULT",
            "Choose an existing captured result/page; this tool does not fetch additional database rows",
            404,
          );
        return {
          run: {
            id: run.id,
            file: run.file,
            sourceRevision: run.sourceRevision,
            target: run.target,
            schemaHash: run.schemaHash,
          },
          result: await this.options.runs.page(run.id, input.resultId!, input.page),
        };
      },
    );
    if (this.options.analyses) {
      register(
        "typed_sql_query_analysis",
        "Capture checked read-only SQL for interactive analysis. Up to 1000 rows/512 KiB/5 seconds. Aggregate in SQL for population counts; truncation is explicit. Returns a datasetId, column ordinals and a small preview; pass datasetId to typed_sql_present. Only captured values can be charted.",
        { sql, values },
        async (input, signal) => {
          const result = await this.query(input.sql, input.values as WireValue[], signal, 1000, 512 * 1024);
          if (result.executed !== true) return result;
          signal.throwIfAborted();
          const dataset = await this.options.analyses!.capture(
            turn.conversationId,
            input.sql,
            input.values as WireValue[],
            result,
            this.options.targetName ?? this.options.target?.classification ?? "offline",
          );
          return {
            datasetId: dataset.id,
            columns: dataset.columns.map((name, index) => ({ index, name })),
            rows: dataset.rows.length,
            complete: dataset.complete,
            preview:
              Buffer.byteLength(JSON.stringify(dataset.rows.slice(0, 5))) < 16384 ? dataset.rows.slice(0, 5) : [],
            previewOmitted: Buffer.byteLength(JSON.stringify(dataset.rows.slice(0, 5))) >= 16384,
            capturedAt: dataset.capturedAt,
          };
        },
      );
      register(
        "typed_sql_get_analysis_data",
        "Read retained analysis data without executing SQL or advancing a cursor. Omit datasetId to discover this conversation's cards and captures. With datasetId, returns column ordinals, source preview and a lossless row page; use small limits for wide data.",
        { datasetId: z.string().uuid().optional(), offset, limit },
        async (input) => {
          if (!input.datasetId)
            return {
              analyses: page(await this.options.analyses!.list(turn.conversationId), input.offset, input.limit),
              datasets: page(await this.options.analyses!.listDatasets(turn.conversationId), input.offset, input.limit),
            };
          const dataset = await this.options.analyses!.dataset(input.datasetId, turn.conversationId);
          return {
            ...page(dataset.rows, input.offset, input.limit),
            columns: dataset.columns,
            complete: dataset.complete,
            capturedAt: dataset.capturedAt,
            source: dataset.source.slice(0, 4096),
            sourceTruncated: dataset.source.length > 4096,
          };
        },
      );
      register(
        "typed_sql_present",
        "Publish an interactive analysis card for a dataset from this conversation. Use column ordinals for views and filters. Metric=one measure; donut/pie=nonnegative parts of a meaningful whole; sunburst/treemap=ordered hierarchy columns and nonnegative additive y; sankey=x source/series target/y weight; heatmap=x/series dimensions/y value. Filters mode=captured operate locally; mode=query binds a zero-based SQL parameter and requires Apply. Explain definitions (e.g. active users) in description. Layout grid composes views. Returns an analysis card ID.",
        presentationSchema.shape,
        async (input, signal) => {
          signal.throwIfAborted();
          const artifact = await this.options.analyses!.publish(turn.conversationId, input);
          return { id: artifact.id, title: artifact.spec.title, published: true };
        },
        false,
      );
    }
    register(
      "typed_sql_propose_file",
      "Propose source for explicit human review within write roots. Requires the read_file revision, or null for a new file. Does not save or execute; the user reviews the diff and separately runs checked code.",
      {
        file,
        source: z.string().max(48 * 1024),
        revision: z.string().nullable(),
        description: z.string().max(500).optional(),
      },
      async (input) => {
        await this.options.files.path(input.file, true);
        return {
          proposal: await turn.propose({
            file: input.file,
            source: input.source,
            revision: input.revision,
            ...(input.description === undefined ? {} : { description: input.description }),
          }),
        };
      },
      false,
    );
    return server;
  }
  async query(
    source: string,
    values: readonly WireValue[],
    signal: AbortSignal,
    rowLimit = 50,
    byteLimit = maximum - 8192,
    expectedIdentity?: { database: string; server: string },
  ): Promise<Record<string, unknown>> {
    if (!this.options.target) throw new WorkspaceError("OFFLINE", "Configure an explicit target before querying", 409);
    const prepared = await this.options.prepare?.(source);
    const snapshot = prepared?.schema ?? this.options.schema(),
      schemaHash = calculateSchemaHash(this.options.schema()),
      analysis = analyzeSql(source, prepared?.dialect ?? this.options.dialect, snapshot, this.options.typePolicy);
    await prepared?.assertCurrent();
    if (!analysis.compiled.query || analysis.compiled.sourceDiagnostics.length)
      return { schemaHash, diagnostics: analysis.compiled.sourceDiagnostics, executed: false };
    const bound = bindSql(analysis, values).map((value) => decodeValue(value));
    let target: PlaygroundTarget | undefined;
    try {
      signal.throwIfAborted();
      const candidate = await bounded(
        Promise.resolve(this.options.target.connect()).then(async (candidate) => {
          if (
            signal.aborted &&
            candidate &&
            typeof candidate === "object" &&
            typeof Reflect.get(candidate, "close") === "function"
          ) {
            await (candidate as PlaygroundTarget).close();
            signal.throwIfAborted();
          }
          return candidate;
        }),
        signal,
      );
      if (
        !candidate ||
        typeof candidate !== "object" ||
        !["identity", "query", "close"].every((name) => typeof Reflect.get(candidate, name) === "function")
      )
        throw new WorkspaceError("TARGET", "Target factory must return a playground service");
      target = candidate as PlaygroundTarget;
      signal.throwIfAborted();
      const identity = await bounded(target.identity(), signal);
      signal.throwIfAborted();
      if (this.options.target.expected?.database === undefined)
        throw new WorkspaceError("TARGET_IDENTITY", "Set target.expected.database before allowing agent queries", 403);
      if (identity.database !== this.options.target.expected.database)
        throw new WorkspaceError("TARGET_IDENTITY", "Observed database differs from expected target", 403);
      if (
        expectedIdentity &&
        (identity.database !== expectedIdentity.database || identity.server !== expectedIdentity.server)
      )
        throw new WorkspaceError(
          "TARGET_IDENTITY",
          "This capture belongs to a different database server; publish a new analysis",
          409,
        );
      if (calculateSchemaHash(this.options.schema()) !== schemaHash)
        throw new WorkspaceError("SCHEMA_STALE", "Captured schema changed; analyze again", 409);
      await prepared?.assertCurrent();
      const raw = await bounded(
        target.query({
          text: analysis.compiled.query.query.sql,
          values: bound,
          readOnly: true,
          maxRows: rowLimit,
          maxResultBytes: byteLimit,
          timeoutMs: 5000,
          signal,
        }),
        signal,
      );
      signal.throwIfAborted();
      const data = {
        ...raw,
        rows: raw.rows.slice(0, rowLimit),
        truncated: raw.truncated || raw.rows.length > rowLimit,
      };
      return {
        schemaHash,
        typePolicyHash: calculateTypePolicyHash(this.options.typePolicy ?? this.options.dialect.defaultTypePolicy),
        schemaSource: this.options.schemaSource?.() ?? "saved",
        sourceHash: contentHash(source),
        statementHash: contentHash(analysis.compiled.query.query.sql),
        parameterCount: values.length,
        parameterTypes: analysis.parameters.map((parameter) => parameter.tsType ?? "unknown"),
        identity,
        value: encodeValue(data, { maxBytes: byteLimit }),
        executed: true,
      };
    } finally {
      if (target) await bounded(target.close(), AbortSignal.timeout(1000));
    }
  }
}
