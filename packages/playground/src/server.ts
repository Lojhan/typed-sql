import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSource } from "@typed-sql/compiler";
import { loadConfig } from "@typed-sql/config";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { AgentRoutes } from "./agents.js";
import { validatePlaygroundConfiguration } from "./configuration.js";
import type { PlaygroundLimits, PlaygroundOptions, PlaygroundTarget } from "./contracts.js";
import { EditorRoutes } from "./editor-service.js";
import { ExplorerService } from "./explorer.js";
import { contentHash, WorkspaceError, WorkspaceFiles } from "./files.js";
import { WorkspaceFormatter } from "./formatter.js";
import { callableExports, RunManager, type RunRequest } from "./runner.js";
import { schemaBoard } from "./schema.js";
import { analyzeSql } from "./sql.js";

export interface PlaygroundServer {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
  close(): Promise<void>;
}
const protocolVersion = 1;
function positive(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new WorkspaceError("LIMIT", `Resource limits must be positive integers no greater than ${maximum}`);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkspaceError("REQUEST", "Expected a JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new WorkspaceError("REQUEST", `${name} must be a string`);
  return value;
}
async function payload(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  if (request.headers["content-type"] !== "application/json")
    throw new WorkspaceError("CONTENT_TYPE", "Use application/json", 415);
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 1024 * 1024) throw new WorkspaceError("REQUEST_LIMIT", "Request exceeds 1 MiB", 413);
    chunks.push(data);
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("JSON", "Invalid JSON request");
  }
}
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};
async function assetDirectory(): Promise<string> {
  for (let root = dirname(fileURLToPath(import.meta.url)); ; root = dirname(root)) {
    try {
      const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
      if (metadata.name === "@typed-sql/playground") return join(root, "dist", "ui");
    } catch {
      /* Continue until the owning package manifest. */
    }
    if (dirname(root) === root) throw new Error("Could not locate playground UI assets");
  }
}

/** Starts a local-only host. No target factory runs until an explicit connect, refresh or Run action. */
export async function startPlayground(options: PlaygroundOptions = {}): Promise<PlaygroundServer> {
  const discovered = await loadConfig({ ...(options.config === undefined ? {} : { file: options.config }) });
  const loaded = {
    ...discovered,
    directory: await realpath(discovered.directory),
    file: await realpath(discovered.file),
  };
  const settings = loaded.config.playground;
  validatePlaygroundConfiguration(settings);
  const scratch = settings?.scratchDirectory ?? "playground";
  const files = new WorkspaceFiles(
    loaded.directory,
    settings?.readRoots ?? ["src", scratch],
    settings?.writeRoots ?? [scratch],
  );
  const limits: PlaygroundLimits = {
    timeoutMs: positive(settings?.limits?.timeoutMs, 30_000, 120_000),
    ...(settings?.limits?.maxRows === undefined ? {} : { maxRows: positive(settings.limits.maxRows, 200, 100_000) }),
    pageSize: positive(settings?.limits?.pageSize, 200, 1000),
    maxSpoolBytes: positive(settings?.limits?.maxSpoolBytes, 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
    cursorIdleMs: positive(settings?.limits?.cursorIdleMs, 30_000, 120_000),
    maxResultBytes: positive(settings?.limits?.maxResultBytes, 5 * 1024 * 1024, 100 * 1024 * 1024),
    maxConsoleBytes: positive(settings?.limits?.maxConsoleBytes, 1024 * 1024, 10 * 1024 * 1024),
  };
  const project = resolve(
    loaded.directory,
    options.project ?? settings?.projects?.[0] ?? loaded.config.projects?.[0] ?? "tsconfig.json",
  );
  const projectRelative = relative(loaded.directory, project);
  if (
    isAbsolute(projectRelative) ||
    projectRelative === ".." ||
    projectRelative.startsWith("../") ||
    projectRelative.startsWith("..\\")
  )
    throw new WorkspaceError("PROJECT", "Selected project must remain within the config directory");
  const selected = options.target === undefined ? undefined : settings?.targets?.[options.target];
  if (options.target !== undefined && selected === undefined)
    throw new WorkspaceError(
      "TARGET",
      `Configure playground.targets.${options.target} with an explicit lazy adapter factory`,
    );
  let schema = loaded.config.dialect.validateSnapshot(
    JSON.parse(await readFile(resolve(loaded.directory, loaded.config.schema.file), "utf8")) as unknown,
  );
  let capturedAt = new Date((await stat(resolve(loaded.directory, loaded.config.schema.file))).mtimeMs).toISOString();
  let schemaSource = "saved";
  const savedSchemaHash = calculateSchemaHash(schema);
  let connection: { identity?: unknown; state: string; message?: string } = {
    state: selected ? "configured" : "offline",
  };
  const formatter = new WorkspaceFormatter(files);
  const manager = new RunManager(loaded, files, limits, options.target, project);
  const migrationsConfig = loaded.config.migrations;
  const migrationDirectory =
    migrationsConfig &&
    typeof migrationsConfig === "object" &&
    "directory" in migrationsConfig &&
    typeof migrationsConfig.directory === "string"
      ? migrationsConfig.directory
      : undefined;
  const explorer = new ExplorerService({
    root: loaded.directory,
    renderer: loaded.config.dialect,
    ...(migrationDirectory === undefined ? {} : { directory: migrationDirectory }),
    snapshot: () => ({ schema, source: schemaSource, capturedAt }),
  });
  let agents: AgentRoutes | undefined;
  let editor: EditorRoutes | undefined;
  manager.expectedSchemaHash = savedSchemaHash;
  const token = randomBytes(32).toString("base64url");
  const assets = await assetDirectory();
  let origin = "";
  const withTarget = async (fn: (target: PlaygroundTarget) => Promise<void>) => {
    if (!selected) throw new WorkspaceError("OFFLINE", "Configure a target and relaunch with --target to connect");
    let service: PlaygroundTarget | undefined;
    try {
      const candidate = await selected.connect();
      if (
        !candidate ||
        typeof candidate !== "object" ||
        !("identity" in candidate) ||
        !("query" in candidate) ||
        !("database" in candidate) ||
        !("close" in candidate)
      )
        throw new WorkspaceError("TARGET", "Target factory must return an explicit playground service");
      if (
        !["identity", "query", "database", "close"].every(
          (method) => typeof Reflect.get(candidate, method) === "function",
        )
      )
        throw new WorkspaceError("TARGET", "Target service methods must be callable");
      service = candidate as PlaygroundTarget;
      const identity = await service.identity();
      if (selected.expected?.database !== undefined && identity.database !== selected.expected.database)
        throw new WorkspaceError("TARGET_IDENTITY", "Observed database differs from the configured expected identity");
      connection = { state: "connected", identity };
      await fn(service);
    } catch (error) {
      connection = {
        state: "unavailable",
        message:
          error instanceof WorkspaceError
            ? error.message
            : "Connection failed. Check driver installation, credentials and server availability in the local terminal.",
      };
      throw error;
    } finally {
      await service?.close();
    }
  };
  const server = createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    void (async () => {
      if (request.headers.host !== new URL(origin).host)
        throw new WorkspaceError("HOST", "Invalid playground Host", 403);
      const requestOrigin = request.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== origin)
        throw new WorkspaceError("ORIGIN", "Cross-origin access is not allowed", 403);
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new WorkspaceError("ORIGIN", "Cross-site access is not allowed", 403);
      const url = new URL(request.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/")) {
        if (request.method !== "GET") throw new WorkspaceError("METHOD", "Method not allowed", 405);
        const name = new Map([
          ["/", "index.html"],
          ["/app.js", "app.js"],
          ["/app.css", "app.css"],
        ]).get(url.pathname);
        if (!name) throw new WorkspaceError("NOT_FOUND", "Not found", 404);
        const bytes = await readFile(join(assets, name));
        response.writeHead(200, {
          "Content-Type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
          "Cache-Control": "no-store",
        });
        response.end(bytes);
        return;
      }
      const supplied = request.headers["x-typed-sql-session"];
      if (
        typeof supplied !== "string" ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        throw new WorkspaceError("SESSION", "Playground session authorization is required", 403);
      if (url.pathname === "/api/agents" || url.pathname.startsWith("/api/agents/")) {
        const method = ["/api/agents", "/api/agents/conversation"].includes(url.pathname) ? "GET" : "POST";
        if (request.method !== method) throw new WorkspaceError("METHOD", "Method not allowed", 405);
        agents ??= new AgentRoutes({ files, trusted: () => manager.trusted });
        const result = await agents.handle(url, request.method === "POST" ? await payload(request) : undefined);
        if (result === undefined) throw new WorkspaceError("NOT_FOUND", "Not found", 404);
        json(response, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/results") {
        const pageText = url.searchParams.get("page") ?? "0";
        if (!/^\d+$/u.test(pageText)) throw new WorkspaceError("PAGE", "Invalid page", 400);
        json(
          response,
          await manager.page(url.searchParams.get("run") ?? "", url.searchParams.get("result") ?? "", Number(pageText)),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/explorer") {
        json(response, await explorer.get());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        const schemaHash = calculateSchemaHash(schema);
        const { files: inventory, folders } = await files.inventory();
        const runList = manager.list();
        const etag = `"${contentHash(JSON.stringify({ schemaHash, inventory, folders, connection, trusted: manager.trusted, runs: runList.map((run) => [run.id, run.status, run.results.map((result) => result.paging ?? null), run.logs.length, run.error, run.finishedAt]) }))}"`;
        response.setHeader("ETag", etag);
        if (request.headers["if-none-match"] === etag) {
          response.writeHead(304);
          response.end();
          return;
        }
        const cursors = new Map(
          (url.searchParams.get("results") ?? "").split(",").map((item) => {
            const [id, count] = item.split(":");
            return [id, Number(count)] as const;
          }),
        );
        json(response, {
          protocolVersion,
          project: {
            name: loaded.directory.split("/").at(-1),
            config: relativeProject(loaded.file),
            tsconfig: relativeProject(project),
          },
          target: options.target ?? null,
          classification: selected?.classification ?? null,
          connection,
          trusted: manager.trusted,
          schemaHash,
          typePolicyHash: calculateTypePolicyHash(loaded.config.typePolicy ?? loaded.config.dialect.defaultTypePolicy),
          capturedAt,
          schemaSource,
          executionSchemaStale: manager.schema !== undefined,
          ...(url.searchParams.get("catalog") === schemaHash ? {} : { board: schemaBoard(schema) }),
          files: inventory,
          folders,
          scratchDirectory: scratch,
          grammar: loaded.config.dialect.id,
          limits,
          runs: runList.map((run) => ({
            ...run,
            ...(cursors.get(run.id) === run.results.length && !run.results.some((result) => result.paging)
              ? { results: undefined }
              : {}),
          })),
        });
        return;
      }
      if (request.method !== "POST") throw new WorkspaceError("METHOD", "Method not allowed", 405);
      const body = await payload(request);
      switch (url.pathname) {
        case "/api/explorer/refresh":
          if (manager.list().some((run) => ["checking", "running", "cancelling"].includes(run.status)))
            throw new WorkspaceError("RUN_ACTIVE", "Wait for active execution before refreshing schema", 409);
          await withTarget(async (target) => {
            if (target.snapshot) {
              schema = loaded.config.dialect.validateSnapshot(await target.snapshot());
              capturedAt = new Date().toISOString();
              schemaSource = "live";
              manager.schema = calculateSchemaHash(schema) === savedSchemaHash ? undefined : schema;
            }
            await explorer.refresh(
              target,
              selected?.expected?.database ?? (connection.identity as { database?: string } | undefined)?.database,
            );
          });
          json(response, await explorer.get());
          return;
        case "/api/editor":
          editor ??= new EditorRoutes({
            files,
            configFile: loaded.file,
            projectFile: project,
            schemaFile: resolve(loaded.directory, loaded.config.schema.file),
            identity: () => ({ savedSchemaHash, liveSchemaHash: calculateSchemaHash(schema) }),
          });
          json(response, await editor.handle(body, manager.trusted));
          return;
        case "/api/format":
          json(
            response,
            await formatter.format(
              {
                file: text(body.file, "file"),
                source: text(body.source, "source"),
                revision: text(body.revision, "revision"),
              },
              manager.trusted,
            ),
          );
          return;
        case "/api/folder":
          json(response, await files.createFolder(text(body.folder, "folder")), 201);
          return;
        case "/api/results/close":
          json(response, manager.closeResult(text(body.run, "run"), text(body.result, "result")));
          return;
        case "/api/file": {
          const file = text(body.file, "file");
          const contents = await files.read(file);
          let writable = true;
          try {
            await files.path(file, true);
          } catch {
            writable = false;
          }
          json(response, { ...contents, writable });
          return;
        }
        case "/api/save":
          json(
            response,
            await files.save(
              text(body.file, "file"),
              text(body.source, "source"),
              body.revision === null ? null : text(body.revision, "revision"),
            ),
          );
          return;
        case "/api/move":
          json(
            response,
            await files.move(text(body.file, "file"), text(body.to, "to"), text(body.revision, "revision")),
          );
          return;
        case "/api/analyze": {
          const file = text(body.file, "file");
          const source = text(body.source, "source");
          await files.path(file);
          if (Buffer.byteLength(source) > 512 * 1024)
            throw new WorkspaceError("FILE_LIMIT", "File exceeds analysis limit");
          if (file.endsWith(".sql")) {
            const sqlAnalysis = analyzeSql(source, loaded.config.dialect, schema, loaded.config.typePolicy);
            const compiled = sqlAnalysis.compiled;
            json(response, {
              revision: contentHash(source),
              diagnostics: compiled.sourceDiagnostics,
              queries: compiled.query
                ? [
                    {
                      rowType: compiled.query.rowType,
                      parameterType: compiled.query.parameterType,
                      sql: compiled.query.query.sql,
                      parameters: sqlAnalysis.parameters,
                      parameterCount: sqlAnalysis.identities.length,
                    },
                  ]
                : [],
              exports: [],
            });
          } else {
            const analysis = analyzeSource(
              { formatVersion: 1, source: { id: await files.path(file), text: source } },
              { dialect: loaded.config.dialect, schema, typePolicy: loaded.config.typePolicy },
            );
            let exports: readonly string[] = [];
            const diagnostics = [...analysis.diagnostics];
            try {
              exports = await callableExports(source, file);
            } catch (error) {
              if (!error || typeof error !== "object" || !("errors" in error) || !Array.isArray(error.errors))
                throw error;
              for (const item of error.errors.slice(0, 100)) {
                if (!item || typeof item.text !== "string" || !item.location) continue;
                const line = Math.max(1, Number(item.location.line) || 1);
                const lines = source.split("\n");
                const prefix = lines.slice(0, line - 1).join("\n");
                const text = lines[line - 1] ?? "";
                const byteColumn = Math.max(0, Number(item.location.column) || 0);
                const column = Buffer.from(text).subarray(0, byteColumn).toString("utf8").length;
                const start = Math.min(source.length, prefix.length + (line > 1 ? 1 : 0) + column);
                const length = Buffer.from(text)
                  .subarray(byteColumn, byteColumn + Math.max(1, Number(item.location.length) || 1))
                  .toString("utf8").length;
                diagnostics.push({
                  code: "TS_SYNTAX",
                  severity: "error",
                  message: item.text,
                  range: { start, end: Math.min(source.length, start + Math.max(1, length)), line, column: column + 1 },
                });
              }
              if (!diagnostics.length) throw error;
            }
            json(response, {
              revision: contentHash(source),
              diagnostics,
              queries: analysis.queries,
              exports,
            });
          }
          return;
        }
        case "/api/sql-types": {
          if (manager.schema)
            throw new WorkspaceError(
              "SCHEMA_STALE",
              "Regenerate the application snapshot and restart before generating SQL declarations",
            );
          const file = text(body.file, "file");
          if (!file.endsWith(".sql")) throw new WorkspaceError("EXTENSION", "Choose a SQL file");
          const input = await files.read(file);
          if (input.revision !== text(body.revision, "revision"))
            throw new WorkspaceError("STALE_SOURCE", "Save the current SQL file before generating declarations", 409);
          const { compiled } = analyzeSql(input.source, loaded.config.dialect, schema, loaded.config.typePolicy);
          if (!compiled.query || compiled.sourceDiagnostics.some((diagnostic) => diagnostic.severity === "error"))
            throw new WorkspaceError("SQL_CHECK", "Fix SQL diagnostics before generating declarations");
          const declaration = file.replace(/\.sql$/u, ".d.sql.ts");
          const header = "// Generated by @typed-sql/build; regenerate with typed-sql-build types.\n";
          let existing: { revision: string; source: string } | undefined;
          try {
            existing = await files.read(declaration);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
          if (existing && !existing.source.replaceAll("\r\n", "\n").startsWith(header))
            throw new WorkspaceError(
              "DECLARATION_OWNERSHIP",
              "An application-owned declaration already exists; it will not be overwritten",
              409,
            );
          json(response, await files.save(declaration, `${header}${compiled.text}`, existing?.revision ?? null));
          return;
        }
        case "/api/trust": {
          if (selected?.classification === "production")
            throw new WorkspaceError("PRODUCTION", "Trusted project execution is disabled on production targets", 403);
          if (body.enable !== true && body.enable !== false)
            throw new WorkspaceError("REQUEST", "enable must be a boolean");
          manager.trusted = body.enable;
          if (!manager.trusted) {
            await editor?.close();
            editor = undefined;
          }
          json(response, { trusted: manager.trusted });
          return;
        }
        case "/api/connect":
          await withTarget(async (target) => {
            await explorer.refresh(
              target,
              selected?.expected?.database ?? (connection.identity as { database?: string } | undefined)?.database,
            );
          });
          json(response, connection);
          return;
        case "/api/refresh":
          if (manager.list().some((run) => ["checking", "running", "cancelling"].includes(run.status)))
            throw new WorkspaceError("RUN_ACTIVE", "Wait for active execution before refreshing schema", 409);
          await withTarget(async (target) => {
            if (!target.snapshot)
              throw new WorkspaceError("CAPABILITY", "Target does not support live catalog capture");
            schema = loaded.config.dialect.validateSnapshot(await target.snapshot());
            capturedAt = new Date().toISOString();
            schemaSource = "live";
            manager.schema = calculateSchemaHash(schema) === savedSchemaHash ? undefined : schema;
            await explorer.refresh(
              target,
              selected?.expected?.database ?? (connection.identity as { database?: string } | undefined)?.database,
            );
          });
          json(response, { schemaHash: calculateSchemaHash(schema), capturedAt });
          return;
        case "/api/run": {
          if (
            typeof body.file !== "string" ||
            typeof body.revision !== "string" ||
            typeof body.requestId !== "string" ||
            !["sql", "file", "export"].includes(String(body.mode)) ||
            (body.readOnly !== undefined && typeof body.readOnly !== "boolean") ||
            (body.values !== undefined && !Array.isArray(body.values))
          )
            throw new WorkspaceError("REQUEST", "Invalid run request");
          json(response, manager.start(body as unknown as RunRequest), 202);
          return;
        }
        case "/api/cancel":
          json(response, manager.cancel(text(body.id, "id")));
          return;
        case "/api/create-query": {
          const tableId = text(body.table, "table");
          const table = schemaBoard(schema).tables.find((item) => item.id === tableId);
          if (!table) throw new WorkspaceError("TABLE", "Select a captured table");
          const file = text(body.file, "file");
          const quote = (value: string) => loaded.config.dialect.quoteIdentifier(value);
          const sql = `select ${table.columns
            .slice(0, 12)
            .map((c) => quote(c.name))
            .join(", ")}\nfrom ${table.namespace ? `${quote(table.namespace)}.` : ""}${quote(table.name)}`;
          if (file.endsWith(".sql")) json(response, await files.save(file, `${sql};\n`, null));
          else {
            const escapeTemplate = (value: string) =>
              value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
            const helper = join(dirname(file), "db.ts").split("\\").join("/");
            try {
              await files.read(helper);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT")
                await files.save(
                  helper,
                  "import { databaseForRun } from '@typed-sql/playground/runtime';\nexport const db = databaseForRun();\n",
                  null,
                );
              else throw error;
            }
            json(
              response,
              await files.save(
                file,
                `import { sql } from ${JSON.stringify(loaded.config.dialect.sqlModule)};\nimport { db } from './db.js';\n\nexport async function run() {\n  return db.all(sql\`${escapeTemplate(sql)}\`);\n}\n`,
                null,
              ),
            );
          }
          return;
        }
        default:
          throw new WorkspaceError("NOT_FOUND", "Not found", 404);
      }
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof WorkspaceError)) process.stderr.write(`Playground operation failed: ${String(error)}\n`);
      json(
        response,
        {
          error: {
            code: error instanceof WorkspaceError ? error.code : "OPERATION_FAILED",
            message:
              error instanceof WorkspaceError
                ? error.message
                : "Operation failed. Inspect the local terminal for connection/configuration details.",
          },
        },
        error instanceof WorkspaceError ? error.status : 500,
      );
    });
  });
  const relativeProject = (path: string) =>
    path.startsWith(`${loaded.directory}/`) ? path.slice(loaded.directory.length + 1) : path.split("/").at(-1);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    token,
    url: `${origin}/#session=${token}`,
    close: async () => {
      await editor?.close();
      await formatter.close();
      await agents?.close();
      await manager.close();
      server.closeAllConnections();
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    },
  };
}
