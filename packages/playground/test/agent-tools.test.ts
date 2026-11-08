import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgres } from "@typed-sql/postgres/analysis";
import { describe, it, strict } from "poku";
import { AgentWorkspaceToolServer } from "../src/agent-tools.js";
import type { PlaygroundQueryRequest, PlaygroundTarget } from "../src/contracts.js";
import { WorkspaceError, WorkspaceFiles } from "../src/files.js";
import { createPgPlaygroundTarget } from "../src/pg.js";
import type { RunRecord } from "../src/runner.js";
import { decodeValue, encodeValue, type WireValue } from "../src/values.js";
import { snapshot } from "./helpers/fixture.js";

interface ToolResult {
  isError?: boolean;
  structuredContent: {
    source: string;
    offset: number;
    nextOffset: number | null;
    items: readonly { id: string }[];
    object: { kind: string };
    state: string;
    revision: string;
    runs: unknown[];
    diagnostics: unknown[];
    executed: boolean;
    error: { code: string; sqlState?: string };
    value: WireValue;
    proposal: { status: string };
  };
}
async function fixture(
  fn: (f: {
    call: (name: string, args?: unknown) => Promise<ToolResult>;
    request: (method: string, params: unknown, authorization?: string) => Promise<Response>;
    close: () => Promise<void>;
    root: string;
    state: {
      trusted: boolean;
      queries: PlaygroundQueryRequest[];
      closed: number;
      database: string;
      fail: boolean;
      errorCode: string;
      sqlState: string;
      wait: boolean;
      proposals: unknown[];
    };
    abort: () => void;
    events: unknown[];
  }) => Promise<void>,
  targetOverride?: () => PlaygroundTarget,
  expectedDatabase = "expected",
) {
  const root = await mkdtemp(join(tmpdir(), "typed-sql-mcp-"));
  await mkdir(join(root, "playground"));
  await writeFile(join(root, "playground/query.sql"), "select 1 as id;\n");
  const state = {
      trusted: true,
      queries: [] as PlaygroundQueryRequest[],
      closed: 0,
      database: "expected",
      fail: false,
      errorCode: "",
      sqlState: "",
      wait: false,
      proposals: [] as unknown[],
    },
    events: unknown[] = [];
  let origin = "";
  const target = {
    identity: async () => ({ database: state.database, server: "local", adapter: "fake", readOnly: true }),
    query: async (input: PlaygroundQueryRequest) => {
      state.queries.push(input);
      if (state.wait)
        await new Promise<void>((_, reject) =>
          input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        );
      if (state.fail)
        throw Object.assign(new Error("PRIVATE password=secret"), { code: state.errorCode, sqlState: state.sqlState });
      return { columns: [{ name: "id", databaseType: "int8" }], rows: [[42n]], truncated: false };
    },
    close: async () => {
      state.closed++;
    },
  } as unknown as PlaygroundTarget;
  const captured: RunRecord = {
    id: "saved",
    file: "playground/query.sql",
    sourceRevision: "captured-source",
    schemaHash: "captured-schema",
    typePolicyHash: "policy",
    mode: "sql",
    target: "local",
    startedAt: "now",
    status: "succeeded",
    parameterFingerprint: "params",
    parameterCount: 0,
    timings: { checkMs: null, buildMs: null, workerMs: null, databaseMs: null, fetchMs: null, totalMs: null },
    results: [
      {
        type: "result",
        name: "query",
        truncated: false,
        provenance: "managed",
        value: encodeValue([[1]]),
        paging: {
          id: "captured-result",
          rowCount: 1,
          pageCount: 1,
          pageSize: 200,
          complete: false,
          source: "database-cursor",
        },
      },
    ],
    diagnostics: [],
    logs: "",
  };
  const tools = new AgentWorkspaceToolServer({
    files: new WorkspaceFiles(root, ["playground"], ["playground"]),
    trusted: () => state.trusted,
    origin: () => origin,
    dialect: postgres(),
    typePolicy: undefined,
    schema: () => ({
      ...snapshot,
      formatVersion: 1 as const,
      functions: {
        "current_setting(text)": {
          name: "current_setting",
          argumentTypes: ["text"],
          databaseReturnType: "text",
          returnType: "string",
          nullable: false,
        },
      },
    }),
    target: {
      classification: "test",
      expected: { database: expectedDatabase },
      connect: () => targetOverride?.() ?? target,
    },
    explorer: async () => ({
      schema: {
        schemaHash: "captured",
        source: "saved",
        capturedAt: "now",
        coverage: "legacy",
        objects: [
          {
            id: "accounts",
            kind: "table",
            namespace: "public",
            name: "accounts",
            details: {},
            history: [],
            historyState: "unknown",
          },
        ],
        links: [],
      },
      migrations: {
        state: "ready",
        entries: Array.from({ length: 13 }, (_, index) => ({
          id: `migration-${index}`,
          status: "applied" as const,
          files: [`migrations/${index}.ts`],
          attempts: [
            {
              migrationId: `migration-${index}`,
              attemptId: `attempt-${index}`,
              direction: "up" as const,
              origin: "executed" as const,
              state: "applied",
              change: "changed" as const,
              evidence: "captured" as const,
              before: { large: "FULL_CATALOG_PAYLOAD".repeat(5000) },
              changes: [],
            },
          ],
        })),
      },
    }),
    runs: {
      list: () => [captured],
      page: async (run, result, page) => {
        strict.equal(run, "saved");
        strict.equal(result, "captured-result");
        strict.equal(page, 0);
        return { value: captured.results[0]!.value, page: 0, complete: false };
      },
    },
  });
  const server = createServer(
    (req, res) =>
      void (async () => {
        try {
          if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin))
            throw new WorkspaceError("ORIGIN", "Invalid origin", 403);
          let text = "";
          for await (const chunk of req) text += chunk;
          await tools.handle(req, res, new URL(req.url!, origin), JSON.parse(text));
        } catch (error) {
          res.writeHead(error instanceof WorkspaceError ? error.status : 500);
          res.end("denied");
        }
      })(),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController(),
    lease = await tools.open({
      conversationId: "test",
      signal: controller.signal,
      propose: async (input) => {
        state.proposals.push(input);
        return { id: "pending", file: input.file, status: "pending" };
      },
      onToolCall: (event) => {
        events.push(event);
      },
    });
  const authorization = lease.mcpServers[0]!.headers[0]!.value;
  let id = 0;
  const request = (method: string, params: unknown, auth = authorization) =>
    fetch(lease.mcpServers[0]!.url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "content-type": "application/json",
        accept: "application/json,text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
  const call = async (name: string, args: unknown = {}) => {
    const response = await request("tools/call", { name, arguments: args });
    strict.equal(response.status, 200);
    const payload = await response.json();
    strict.ok(!payload.error);
    return payload.result as ToolResult;
  };
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    strict.equal(init.status, 200);
    await fn({ call, request, close: lease.close, root, state, abort: () => controller.abort(), events });
  } finally {
    await lease.close();
    await tools.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
await describe("scoped workspace MCP tools", async () => {
  await it("bounds response bytes and aborts a managed query when its turn is revoked", async () =>
    fixture(async (f) => {
      await writeFile(join(f.root, "playground/large.ts"), "x".repeat(40000));
      const tooLarge = await f.call("typed_sql_read_file", { file: "playground/large.ts" });
      strict.equal(tooLarge.isError, true);
      f.state.wait = true;
      const pending = f.call("typed_sql_query_readonly", { sql: "select 1 as value" }).catch(() => undefined);
      while (!f.state.queries.length) await new Promise((resolve) => setTimeout(resolve, 5));
      f.abort();
      await pending;
      for (let i = 0; i < 100 && !f.state.closed; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      strict.equal(f.state.queries[0]?.signal.aborted, true);
      strict.equal(f.state.closed, 1);
    }));
  await it("discovers nine annotated tools and reads paginated saved schema/files without opening a target", async () =>
    fixture(async (f) => {
      const listed = await (await f.request("tools/list", {})).json();
      strict.equal(listed.result.tools.length, 9);
      strict.ok(
        listed.result.tools.every(
          (tool: { inputSchema: { type: string }; annotations: { destructiveHint: boolean } }) =>
            tool.inputSchema.type === "object" && tool.annotations.destructiveHint === false,
        ),
      );
      const schema = await f.call("typed_sql_get_schema", { limit: 1 });
      strict.equal(schema.structuredContent.source, "saved");
      strict.equal(schema.structuredContent.items[0]?.id, "accounts");
      const laterPage = await f.call("typed_sql_get_schema", { offset: 5001, limit: 1 });
      strict.equal(laterPage.structuredContent.offset, 5001);
      strict.deepEqual(laterPage.structuredContent.items, []);
      strict.equal(laterPage.structuredContent.nextOffset, null);
      strict.ok(Buffer.byteLength(JSON.stringify(laterPage)) < 64 * 1024);
      strict.equal((await f.call("typed_sql_get_object", { id: "accounts" })).structuredContent.object.kind, "table");
      const migrations = await f.call("typed_sql_list_migrations");
      strict.equal(migrations.structuredContent.state, "ready");
      strict.equal(migrations.structuredContent.items.length, 13);
      strict.ok(!JSON.stringify(migrations).includes("FULL_CATALOG_PAYLOAD"));
      strict.deepEqual((await f.call("typed_sql_list_files")).structuredContent.items, ["playground/query.sql"]);
      const read = await f.call("typed_sql_read_file", { file: "playground/query.sql", line: 1, limit: 1 });
      strict.equal(read.structuredContent.source, "select 1 as id;");
      strict.equal(typeof read.structuredContent.revision, "string");
      strict.equal((await f.call("typed_sql_read_file", { file: "../private.ts" })).isError, true);
      strict.equal((await f.call("typed_sql_get_result")).structuredContent.runs.length, 1);
      const saved = await f.call("typed_sql_get_result", { runId: "saved", resultId: "captured-result", page: 0 });
      strict.ok(JSON.stringify(saved.structuredContent).includes("captured-source"));
      strict.ok(JSON.stringify(saved.structuredContent).includes("captured-schema"));
      strict.equal(
        (await f.call("typed_sql_get_result", { runId: "saved", resultId: "captured-result", page: 1 })).isError,
        true,
      );
      strict.equal((await f.call("typed_sql_get_result", { runId: "missing", resultId: "id" })).isError, true);
      strict.equal(f.state.queries.length, 0);
      strict.equal(f.state.closed, 0);
      const events = f.events as { id: string; name: string; state: string }[];
      strict.equal(events[0]?.state, "running");
      strict.equal(events[1]?.state, "completed");
      strict.equal(events[0]?.id, events[1]?.id);
    }));
  await it("checks and compiles named SQL with typed lossless bindings, readonly bounds and cleanup", async () =>
    fixture(async (f) => {
      const analysis = await f.call("typed_sql_analyze_sql", { sql: "select id from public.accounts where id=:id" });
      strict.deepEqual(analysis.structuredContent.diagnostics, []);
      const queried = await f.call("typed_sql_query_readonly", {
        sql: "select id from public.accounts where id=:id",
        values: [42],
      });
      strict.equal(queried.structuredContent.executed, true);
      const data = decodeValue(queried.structuredContent.value) as { rows: unknown[][] };
      strict.equal(data.rows[0]?.[0], 42n);
      strict.equal(f.state.queries[0]?.text, "select id from public.accounts where id=$1");
      strict.deepEqual(f.state.queries[0]?.values, [42]);
      strict.equal(f.state.queries[0]?.readOnly, true);
      strict.equal(f.state.queries[0]?.maxRows, 50);
      strict.equal(f.state.queries[0]?.timeoutMs, 5000);
      strict.equal(f.state.closed, 1);
      strict.equal(
        (await f.call("typed_sql_query_readonly", { sql: "select unknown_fn(1)" })).structuredContent.executed,
        false,
      );
      strict.equal(
        (
          await f.call("typed_sql_query_readonly", {
            sql: "select id from public.accounts where id=:id",
            values: ["wrong"],
          })
        ).isError,
        true,
      );
      strict.equal(f.state.queries.length, 1);
      f.state.database = "wrong";
      strict.equal((await f.call("typed_sql_query_readonly", { sql: "select 1 as value" })).isError, true);
      strict.equal(f.state.closed, 2);
      f.state.database = "expected";
      f.state.fail = true;
      const error = await f.call("typed_sql_query_readonly", { sql: "select 1 as value" });
      strict.equal(error.isError, true);
      strict.ok(!JSON.stringify(error).includes("PRIVATE"));
      strict.equal(f.state.closed, 3);
      f.state.errorCode = "TSQL_PLAYGROUND_READ_ONLY";
      const adapterBlocked = await f.call("typed_sql_query_readonly", { sql: "select 1 as value" });
      strict.equal(adapterBlocked.structuredContent.error.code, "READ_ONLY");
      strict.ok(!JSON.stringify(adapterBlocked).includes("25006"));
      f.state.sqlState = "25006";
      const databaseBlocked = await f.call("typed_sql_query_readonly", { sql: "select 1 as value" });
      strict.equal(databaseBlocked.structuredContent.error.sqlState, "25006");
      strict.ok(!JSON.stringify(databaseBlocked).includes("PRIVATE"));
    }));
  await it("proposes only reviewable source and revokes tokens on idle, cancellation and trust loss", async () =>
    fixture(async (f) => {
      const response = await f.call("typed_sql_propose_file", {
        file: "playground/new.ts",
        source: "export const id=1;",
        revision: null,
      });
      strict.equal(response.structuredContent.proposal.status, "pending");
      await strict.rejects(readFile(join(f.root, "playground/new.ts")));
      strict.equal(f.state.proposals.length, 1);
      strict.equal(
        (await f.call("typed_sql_propose_file", { file: "outside.ts", source: "bad", revision: null })).isError,
        true,
      );
      f.state.trusted = false;
      strict.equal((await f.request("tools/list", {})).status, 403);
      f.state.trusted = true;
      strict.equal((await f.request("tools/list", {}, "browser-session-token")).status, 403);
      f.abort();
      strict.equal((await f.request("tools/list", {})).status, 403);
      await f.close();
    }));
});

if (process.env.TYPED_SQL_PLAYGROUND_PG_URL) {
  await describe("real PostgreSQL workspace MCP execution", async () => {
    await it("enforces read-only transactions, bounded cursor results and compiled typed bindings", async () => {
      const target = createPgPlaygroundTarget({ connectionString: process.env.TYPED_SQL_PLAYGROUND_PG_URL! });
      const identity = await target.identity();
      await target.close();
      const fresh = () => {
        const service = createPgPlaygroundTarget({ connectionString: process.env.TYPED_SQL_PLAYGROUND_PG_URL! });
        return service;
      };
      await fixture(
        async (f) => {
          const readOnly = await f.call("typed_sql_query_readonly", {
            sql: "select current_setting('transaction_read_only') as setting",
          });
          strict.equal(readOnly.structuredContent.executed, true);
          strict.deepEqual((decodeValue(readOnly.structuredContent.value) as { rows: unknown }).rows, [["on"]]);
          const many = await f.call("typed_sql_query_readonly", {
            sql: "select n from generate_series(1,80) as series(n)",
          });
          const data = decodeValue(many.structuredContent.value) as { rows: unknown[][]; truncated: boolean };
          strict.equal(data.rows.length, 50);
          strict.equal(data.truncated, true);
          // Each tool call owns and closes a fresh service, so supply a fresh pool for the next call.
        },
        fresh,
        identity.database,
      );
    });
  });
}
