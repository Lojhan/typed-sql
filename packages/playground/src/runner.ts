import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildSession } from "@typed-sql/build";
import { checkFile, compileSqlFile, listProjectSourceFiles } from "@typed-sql/compiler";
import type { LoadedConfig } from "@typed-sql/config";
import type { SchemaSnapshot } from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { parse } from "acorn";
import { build, transform } from "esbuild";
import { validatePlaygroundConfiguration } from "./configuration.js";
import type { PlaygroundLimits } from "./contracts.js";
import { databaseDiagnostic, type RunDatabaseDiagnostic } from "./database-diagnostics.js";
import { contentHash, WorkspaceError, type WorkspaceFiles } from "./files.js";
import { analyzeSql, bindSql } from "./sql.js";
import { decodeValue, type WireValue } from "./values.js";
import { validateWorkerEvent, type WorkerEvent, type WorkerRequest } from "./worker-protocol.js";

export interface RunRequest {
  readonly requestId: string;
  readonly file: string;
  readonly revision: string;
  readonly mode: "file" | "export" | "sql";
  readonly exportName?: string;
  readonly values?: readonly WireValue[];
  readonly readOnly?: boolean;
}
export interface RunRecord {
  readonly id: string;
  readonly file: string;
  readonly sourceRevision: string;
  readonly mode: string;
  readonly target: string | null;
  readonly startedAt: string;
  readonly parameterFingerprint: string;
  readonly parameterCount: number;
  readonly timings: {
    checkMs: number | null;
    buildMs: number | null;
    workerMs: number | null;
    databaseMs: null;
    fetchMs: number | null;
    totalMs: number | null;
  };
  schemaHash: string | null;
  readonly typePolicyHash: string;
  finishedAt?: string;
  status: "checking" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "outcome-unknown";
  results: Extract<WorkerEvent, { type: "result" }>[];
  diagnostics: RunDatabaseDiagnostic[];
  logs: string;
  error?: { readonly code: string; readonly message: string };
}

/** Static export discovery operates on transpiled syntax, never importing the project file. */
function sourceLoader(file: string): "ts" | "tsx" | "js" | "jsx" {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?js$/u.test(file)) return "js";
  if (/\.[cm]?ts$/u.test(file)) return "ts";
  throw new WorkspaceError("EXTENSION", "Select a TypeScript or JavaScript source file");
}
export async function callableExports(source: string, file = "query.ts"): Promise<readonly string[]> {
  const js = await transform(source, { loader: sourceLoader(file), format: "esm", target: "es2022" });
  const program = parse(js.code, { ecmaVersion: "latest", sourceType: "module" });
  const functions = new Set<string>();
  const exports: [string, string][] = [];
  for (const node of program.body) {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (declaration?.type === "FunctionDeclaration" && declaration.id && declaration.params.length === 0)
      functions.add(declaration.id.name);
    if (declaration?.type === "VariableDeclaration")
      for (const item of declaration.declarations) {
        if (
          item.id.type === "Identifier" &&
          (item.init?.type === "ArrowFunctionExpression" || item.init?.type === "FunctionExpression") &&
          item.init.params.length === 0
        )
          functions.add(item.id.name);
      }
    if (node.type === "ExportNamedDeclaration") {
      if (declaration?.type === "FunctionDeclaration" && declaration.id)
        exports.push([declaration.id.name, declaration.id.name]);
      if (declaration?.type === "VariableDeclaration")
        for (const item of declaration.declarations)
          if (item.id.type === "Identifier") exports.push([item.id.name, item.id.name]);
      if (!node.source)
        for (const item of node.specifiers)
          exports.push([
            item.local.type === "Identifier" ? item.local.name : String(item.local.value),
            item.exported.type === "Identifier" ? item.exported.name : String(item.exported.value),
          ]);
    }
  }
  return exports.filter(([local]) => functions.has(local)).map(([, name]) => name);
}

export class RunManager {
  readonly records = new Map<string, RunRecord>();
  private readonly resultWaiters = new Set<() => void>();
  private readonly resultDirectories = new Map<string, string>();
  private readonly requests = new Map<string, { fingerprint: string; recordId: string }>();
  private active: { record: RunRecord; controller: AbortController; child?: ChildProcess } | undefined;
  trusted = false;
  schema: SchemaSnapshot | undefined;
  expectedSchemaHash: string | undefined;
  private readonly configurationFiles: Promise<readonly { path: string; hash: string }[]>;
  constructor(
    readonly loaded: LoadedConfig,
    readonly files: WorkspaceFiles,
    readonly limits: PlaygroundLimits,
    readonly target: string | undefined,
    readonly project: string,
  ) {
    validatePlaygroundConfiguration(loaded.config.playground);
    this.configurationFiles = Promise.all(
      (loaded.dependencies ?? [loaded.file]).map(async (path) => ({
        path,
        hash: contentHash(await readFile(path, "utf8")),
      })),
    );
  }
  list(): readonly RunRecord[] {
    return [...this.records.values()].reverse();
  }
  start(request: RunRequest): RunRecord {
    if (!/^[a-zA-Z0-9-]{8,80}$/u.test(request.requestId))
      throw new WorkspaceError("REQUEST_ID", "A unique run request ID is required");
    const fingerprint = contentHash(JSON.stringify(request));
    const previous = this.requests.get(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkspaceError("REQUEST_CONFLICT", "Run ID was already used for different source", 409);
      const retained = this.records.get(previous.recordId);
      if (!retained)
        throw new WorkspaceError(
          "RUN_EXPIRED",
          "This request already executed, but its result has expired from memory. It will not be replayed.",
          409,
        );
      return retained;
    }
    if (this.requests.size >= 10_000)
      throw new WorkspaceError(
        "SESSION_LIMIT",
        "This session reached 10,000 unique runs. Restart the workspace to continue; old request IDs remain non-replayable.",
        409,
      );
    if (this.active) throw new WorkspaceError("RUN_ACTIVE", "Cancel or wait for the active run", 409);
    if (request.mode !== "sql" && !this.trusted)
      throw new WorkspaceError(
        "TRUST_REQUIRED",
        "Enable trusted project execution for this session before running TypeScript",
        403,
      );
    const selected = this.target === undefined ? undefined : this.loaded.config.playground?.targets?.[this.target];
    if (selected?.classification === "production" && request.mode !== "sql")
      throw new WorkspaceError("PRODUCTION", "Trusted TypeScript execution is disabled on production targets", 403);
    if (!["sql", "file", "export"].includes(request.mode)) throw new WorkspaceError("RUN_MODE", "Unknown run mode");
    if (!this.target) throw new WorkspaceError("OFFLINE", "Select an explicitly configured target to execute files");
    const record: RunRecord = {
      id: randomUUID(),
      file: request.file,
      sourceRevision: request.revision,
      mode: request.mode,
      target: this.target ?? null,
      startedAt: new Date().toISOString(),
      parameterFingerprint: contentHash(JSON.stringify(request.values ?? [])),
      parameterCount: request.values?.length ?? 0,
      timings: { checkMs: null, buildMs: null, workerMs: null, databaseMs: null, fetchMs: null, totalMs: null },
      schemaHash: this.expectedSchemaHash ?? null,
      typePolicyHash: calculateTypePolicyHash(
        this.loaded.config.typePolicy ?? this.loaded.config.dialect.defaultTypePolicy,
      ),
      status: "checking",
      results: [],
      diagnostics: [],
      logs: "",
    };
    this.records.set(record.id, record);
    this.requests.set(request.requestId, { fingerprint, recordId: record.id });
    while (this.records.size > 10) {
      const oldest = this.records.keys().next().value!;
      this.records.delete(oldest);
      const directory = this.resultDirectories.get(oldest);
      this.resultDirectories.delete(oldest);
      if (directory) void rm(directory, { recursive: true, force: true });
    }
    const active = { record, controller: new AbortController() };
    this.active = active;
    const startTime = performance.now();
    void this.execute(request, active)
      .catch((error) => {
        record.status = "failed";
        record.error = {
          code: error instanceof WorkspaceError ? error.code : "CHECK_FAILED",
          message:
            error instanceof WorkspaceError
              ? error.message
              : "Project checking/build failed. See local terminal for details.",
        };
        if (!(error instanceof WorkspaceError)) process.stderr.write(`${String(error)}\n`);
      })
      .finally(() => {
        record.finishedAt = new Date().toISOString();
        record.timings.totalMs = performance.now() - startTime;
        if (this.active === active) this.active = undefined;
        for (const waiter of this.resultWaiters) waiter();
      });
    return record;
  }
  cancel(id: string): RunRecord {
    const active = this.active;
    if (!active || active.record.id !== id)
      throw new WorkspaceError("RUN_MISSING", "This run is no longer active", 409);
    active.record.status = "cancelling";
    active.controller.abort();
    if (active.child?.connected) active.child.send({ cancel: true });
    const timer = setTimeout(() => active.child?.kill("SIGKILL"), 2000);
    timer.unref();
    return active.record;
  }
  async page(run: string, result: string, page: number): Promise<unknown> {
    if (!Number.isSafeInteger(page) || page < 0)
      throw new WorkspaceError("PAGE", "Page must be a nonnegative integer", 400);
    const record = this.records.get(run);
    if (!record) throw new WorkspaceError("RUN_EXPIRED", "Captured run has expired", 410);
    const find = () => record.results.find((event) => event.paging?.id === result);
    let event = find();
    if (!event?.paging) throw new WorkspaceError("RESULT_MISSING", "Captured result does not exist", 404);
    if (page > event.paging.pageCount) throw new WorkspaceError("PAGE", "Fetch pages in order", 416);
    if (page === event.paging.pageCount && !event.paging.complete && this.active?.record === record) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new WorkspaceError("PAGE_TIMEOUT", "Cursor page did not arrive", 408));
        }, this.limits.timeoutMs + 5000);
        const cleanup = () => {
          clearTimeout(timer);
          this.resultWaiters.delete(changed);
        };
        const changed = () => {
          const next = find()?.paging;
          if (!next || page < next.pageCount || next.complete || !["running", "cancelling"].includes(record.status)) {
            cleanup();
            resolve();
          }
        };
        this.resultWaiters.add(changed);
        this.active?.child?.send({ pull: result });
      });
      event = find()!;
    }
    const paging = event.paging!;
    if (page >= paging.pageCount) return { value: null, hasPage: false, page, nextPage: null, ...paging };
    const directory = this.resultDirectories.get(run);
    if (!directory) throw new WorkspaceError("RUN_EXPIRED", "Captured pages have expired", 410);
    let value: WireValue;
    try {
      value = JSON.parse(await readFile(join(directory, result, `${page}.json`), "utf8")) as WireValue;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new WorkspaceError("RUN_EXPIRED", "Captured pages have expired", 410);
      throw error;
    }
    decodeValue(value);
    return {
      value,
      hasPage: true,
      page,
      nextPage:
        page + 1 < paging.pageCount ||
        (!paging.complete && this.active?.record === record && record.status === "running")
          ? page + 1
          : null,
      ...paging,
    };
  }
  closeResult(run: string, result: string): RunRecord {
    const record = this.records.get(run);
    if (!record?.results.some((event) => event.paging?.id === result))
      throw new WorkspaceError("RESULT_MISSING", "Captured result does not exist", 404);
    return this.cancel(run);
  }
  async close(): Promise<void> {
    const active = this.active;
    if (!active) {
      await Promise.all([...this.resultDirectories.values()].map((path) => rm(path, { recursive: true, force: true })));
      return;
    }
    this.cancel(active.record.id);
    await new Promise<void>((resolve) => {
      if (!active.child) {
        resolve();
        return;
      }
      active.child.once("exit", () => resolve());
      const timer = setTimeout(() => {
        active.child?.kill("SIGKILL");
        resolve();
      }, 2500);
      timer.unref();
    });
    await Promise.all([...this.resultDirectories.values()].map((path) => rm(path, { recursive: true, force: true })));
  }
  private async execute(
    request: RunRequest,
    active: { record: RunRecord; controller: AbortController; child?: ChildProcess },
  ): Promise<void> {
    const { record, controller } = active;
    const preflightStarted = performance.now();
    const source = await this.files.read(request.file);
    if (source.revision !== request.revision)
      throw new WorkspaceError("STALE_SOURCE", "File changed since the Run action; reload or save and run again", 409);
    for (const captured of await this.configurationFiles) {
      if (contentHash(await readFile(captured.path, "utf8")) !== captured.hash)
        throw new WorkspaceError(
          "CONFIG_CHANGED",
          "Project configuration changed. Restart the workspace before execution.",
          409,
        );
    }
    const session = new BuildSession({ cwd: this.loaded.directory, config: this.loaded.file });
    const project = await session.project();
    record.schemaHash = calculateSchemaHash(project.snapshot);
    if (this.expectedSchemaHash !== undefined && calculateSchemaHash(project.snapshot) !== this.expectedSchemaHash)
      throw new WorkspaceError(
        "SCHEMA_CHANGED",
        "Saved compiler schema changed. Restart the workspace before execution.",
        409,
      );
    if (this.schema)
      throw new WorkspaceError(
        "SCHEMA_STALE",
        "Live schema differs from the saved compiler snapshot. Regenerate the application contract and restart before execution.",
      );
    const captured = new Map<string, string>();
    let sql: string | undefined;
    let sqlOffsets: readonly number[] | undefined;
    let boundValues = request.values;
    if (request.mode === "sql") {
      if (!request.file.endsWith(".sql")) throw new WorkspaceError("RUN_MODE", "SQL mode requires a SQL file");
      const sqlAnalysis = analyzeSql(
        source.source,
        this.loaded.config.dialect,
        project.snapshot,
        this.loaded.config.typePolicy,
      );
      const compiled = sqlAnalysis.compiled;
      if (!compiled.query || compiled.sourceDiagnostics.some((d) => d.severity === "error"))
        throw new WorkspaceError(
          "SQL_CHECK",
          compiled.sourceDiagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      // compileSqlFile normalizes the selected grammar's placeholders and preserves bindings.
      sql = compiled.query.query.sql;
      sqlOffsets = compiled.query.query.sqlOffsetMap;
      boundValues = bindSql(sqlAnalysis, request.values ?? []);
      captured.set(await this.files.path(request.file), source.source);
    } else {
      if (/\.c(?:ts|js)$/u.test(request.file))
        throw new WorkspaceError(
          "RUN_MODE",
          "CommonJS files can be edited, but Run requires an ESM TypeScript or JavaScript entry",
        );
      if (!/\.(?:mts|ts|tsx|mjs|js|jsx)$/u.test(request.file))
        throw new WorkspaceError("RUN_MODE", "Select an ESM TypeScript or JavaScript file");
      if (
        request.mode === "export" &&
        !(await callableExports(source.source, request.file)).includes(request.exportName ?? "run")
      )
        throw new WorkspaceError("EXPORT", "Select a statically declared zero-argument exported function");
      const reachable = await listProjectSourceFiles({
        project: this.project,
        cwd: this.loaded.directory,
        entryFile: await this.files.path(request.file),
        includeSqlAssets: true,
        typeScriptTimeoutMs: this.limits.timeoutMs,
      });
      for (const sqlFile of reachable.filter((path) => path.endsWith(".sql"))) {
        const sqlSource = await readFile(sqlFile, "utf8");
        const declarationFile = sqlFile.replace(/\.sql$/u, ".d.sql.ts");
        const declaration = compileSqlFile({
          source: sqlSource,
          dialect: this.loaded.config.dialect,
          schema: project.snapshot,
          typePolicy: this.loaded.config.typePolicy,
        });
        if (!declaration.query) throw new WorkspaceError("SQL_CHECK", `Imported SQL failed analysis: ${sqlFile}`);
        let currentDeclaration: string;
        try {
          currentDeclaration = await readFile(declarationFile, "utf8");
        } catch {
          throw new WorkspaceError(
            "SQL_DECLARATION",
            `Imported SQL needs current TypeScript declarations: ${sqlFile}. Open it and choose Generate TS types, or run the application's typed-sql build types command.`,
          );
        }
        const normalized = currentDeclaration
          .replaceAll("\r\n", "\n")
          .replace(/^\/\/ Generated by @typed-sql\/build;[^\n]*\n/u, "")
          .trim();
        if (normalized !== declaration.text.trim())
          throw new WorkspaceError(
            "SQL_DECLARATION_STALE",
            `Imported SQL declarations are stale: ${sqlFile}. Generate TS types before running.`,
          );
        captured.set(sqlFile, sqlSource);
        captured.set(declarationFile, currentDeclaration);
      }
      const checked = await checkFile({
        file: await this.files.path(request.file),
        project: this.project,
        dialect: this.loaded.config.dialect,
        schema: project.snapshot,
        typePolicy: this.loaded.config.typePolicy,
        typeScriptTimeoutMs: this.limits.timeoutMs,
      });
      if (!checked.ok)
        throw new WorkspaceError(
          "TYPECHECK",
          `${checked.sqlDiagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}\n${checked.typeScript?.output ?? ""}`.trim(),
        );
      for (const file of checked.files ?? []) captured.set(file.file, file.analysis.source);
    }
    for (const file of project.watchedFiles) if (!captured.has(file)) captured.set(file, await readFile(file, "utf8"));
    for (const file of [
      this.project,
      join(this.loaded.directory, "package.json"),
      join(this.loaded.directory, "pnpm-lock.yaml"),
      join(this.loaded.directory, "package-lock.json"),
    ]) {
      try {
        captured.set(file, await readFile(file, "utf8"));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    record.timings.checkMs = performance.now() - preflightStarted;
    const buildStarted = performance.now();
    const runDirectory = join(await realpath(this.loaded.directory), ".typed-sql", "playground", "runs", record.id);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    this.resultDirectories.set(record.id, runDirectory);
    const entry = join(runDirectory, "entry.mjs");
    try {
      if (request.mode !== "sql") {
        const built = await build({
          absWorkingDir: this.loaded.directory,
          entryPoints: [await this.files.path(request.file)],
          bundle: true,
          packages: "external",
          platform: "node",
          format: "esm",
          target: "node22",
          outfile: entry,
          write: false,
          sourcemap: "inline",
          metafile: true,
          logLevel: "silent",
          tsconfig: this.project,
          plugins: [
            {
              name: "playground-capture",
              setup(builder) {
                builder.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
                  if (!/\.(?:sql|[cm]?[jt]sx?)$/u.test(args.path))
                    throw new WorkspaceError(
                      "MODULE_GRAPH",
                      "Local non-code assets (including JSON) are not supported in captured runs. Use static TypeScript/ESM data modules.",
                    );
                  if (/\.c(?:ts|js)$/u.test(args.path))
                    throw new WorkspaceError(
                      "MODULE_GRAPH",
                      "CommonJS project files are not supported by this runner; use ESM scratch entries",
                    );
                  const original = captured.get(args.path) ?? (await readFile(args.path, "utf8"));
                  const parsed = parse(
                    (
                      await transform(original, {
                        loader: args.path.endsWith(".sql") ? "text" : sourceLoader(args.path),
                        format: "esm",
                      })
                    ).code,
                    { ecmaVersion: "latest", sourceType: "module" },
                  );
                  const inspect = (value: unknown): void => {
                    if (!value || typeof value !== "object") return;
                    if (Array.isArray(value)) {
                      for (const item of value) inspect(item);
                      return;
                    }
                    const node = value as Record<string, unknown>;
                    if (node.type === "ImportExpression")
                      throw new WorkspaceError(
                        "MODULE_GRAPH",
                        "Dynamic project imports are not supported in captured runs; use static imports",
                      );
                    if (
                      node.type === "CallExpression" &&
                      node.callee &&
                      typeof node.callee === "object" &&
                      "name" in node.callee &&
                      node.callee.name === "require"
                    )
                      throw new WorkspaceError("MODULE_GRAPH", "CommonJS require() is not supported in captured runs");
                    for (const child of Object.values(node)) inspect(child);
                  };
                  inspect(parsed);
                  captured.set(args.path, original);
                  const transformed = await session.transform(original, args.path);
                  return {
                    contents: transformed
                      ? `${transformed.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(transformed.map)).toString("base64")}`
                      : original,
                    loader: transformed
                      ? args.path.endsWith(".jsx")
                        ? "tsx"
                        : transformed.language
                      : args.path.endsWith(".sql")
                        ? "js"
                        : sourceLoader(args.path),
                    resolveDir: dirname(args.path),
                  };
                });
              },
            },
          ],
        }).catch((error: unknown) => {
          if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
            for (const diagnostic of error.errors)
              if (
                diagnostic &&
                typeof diagnostic === "object" &&
                "detail" in diagnostic &&
                diagnostic.detail instanceof WorkspaceError
              )
                throw diagnostic.detail;
          }
          throw error;
        });
        if (built.warnings.length)
          throw new WorkspaceError("MODULE_GRAPH", built.warnings.map((w) => w.text).join("\n"));
        await writeFile(entry, built.outputFiles[0]!.contents, { mode: 0o600 });
        const resolver = createRequire(join(this.loaded.directory, "package.json"));
        for (const imported of Object.values(built.metafile.inputs)
          .flatMap((input) => input.imports)
          .filter((item) => item.external)) {
          if (imported.path.startsWith("node:")) continue;
          let resolved: string;
          try {
            resolved = resolver.resolve(imported.path);
          } catch {
            throw new WorkspaceError("MODULE_GRAPH", `Cannot resolve external dependency ${imported.path}`);
          }
          if (!isAbsolute(resolved)) continue;
          captured.set(resolved, await readFile(resolved, "utf8"));
          const packageName = imported.path.startsWith("@")
            ? imported.path.split("/").slice(0, 2).join("/")
            : imported.path.split("/")[0]!;
          let directory = dirname(resolved);
          while (true) {
            try {
              const manifest = await readFile(join(directory, "package.json"), "utf8");
              if ((JSON.parse(manifest) as { name?: string }).name === packageName) {
                captured.set(join(directory, "package.json"), manifest);
                break;
              }
            } catch {}
            if (dirname(directory) === directory) break;
            directory = dirname(directory);
          }
        }
        record.logs +=
          "Execution graph: captured local ESM modules; installed external packages remain trusted and are checked by entry/package identity.\n";
      }
      const files = [...captured].map(([path, text]) => ({ path, hash: contentHash(text) }));
      for (const file of files)
        if (contentHash(await readFile(file.path, "utf8")) !== file.hash)
          throw new WorkspaceError("STALE_SOURCE", "Project files changed during checking; run again", 409);
      if (controller.signal.aborted) {
        record.status = "cancelled";
        return;
      }
      const worker = fileURLToPath(
        new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
      );
      record.timings.buildMs = performance.now() - buildStarted;
      const workerStarted = performance.now();
      const child = fork(worker, [], {
        cwd: this.loaded.directory,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: worker.endsWith(".ts")
          ? ["--max-old-space-size=256", "--import", createRequire(import.meta.url).resolve("tsx/esm")]
          : ["--max-old-space-size=256", "--enable-source-maps"],
        serialization: "json",
        env: { ...process.env, NODE_OPTIONS: "" },
      });
      active.child = child;
      record.status = "running";
      const expire = () => {
        controller.abort();
        if (child.connected) child.send({ cancel: true });
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        record.status = "cancelling";
      };
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const armDeadline = (milliseconds: number) => {
        clearTimeout(deadline);
        deadline = setTimeout(expire, milliseconds);
        deadline.unref();
      };
      armDeadline(this.limits.timeoutMs);
      let completed = false;
      let workerError = false;
      const appendLog = (data: Buffer) => {
        const remaining = this.limits.maxConsoleBytes - Buffer.byteLength(record.logs);
        if (remaining > 0) record.logs += data.subarray(0, remaining).toString("utf8");
      };
      child.stdout?.on("data", appendLog);
      child.stderr?.on("data", appendLog);
      child.on("message", (incoming: unknown) => {
        let event: WorkerEvent;
        try {
          event = validateWorkerEvent(incoming, this.limits.maxResultBytes);
        } catch {
          workerError = true;
          record.error = { code: "WORKER_PROTOCOL", message: "Worker returned an invalid or oversized event" };
          controller.abort();
          child.kill();
          return;
        }
        if (event.type === "cursor-wait" || event.type === "cursor-fetch") {
          if (request.mode !== "sql" || request.readOnly === false) {
            workerError = true;
            record.error = { code: "WORKER_PROTOCOL", message: "Cursor lifecycle is only valid for raw read-only SQL" };
            controller.abort();
            child.kill();
            return;
          }
          // A partial result never disables execution limits. Cursor idle gets its own bounded watchdog.
          armDeadline(
            event.type === "cursor-wait" ? (this.limits.cursorIdleMs ?? 30_000) + 2000 : this.limits.timeoutMs,
          );
        } else if (event.type === "local-error") {
          process.stderr.write(`Playground worker: ${event.message}\n`);
        } else if (event.type === "result") {
          if (event.timings) record.timings.fetchMs = event.timings.fetchMs;
          const index = record.results.findIndex((existing) => event.paging && existing.paging?.id === event.paging.id);
          if (index >= 0) record.results[index] = event;
          else if (record.results.length < 10) record.results.push(event);
          else {
            workerError = true;
            record.error = { code: "RESULT_LIMIT", message: "Result set limit reached" };
            controller.abort();
            child.kill();
          }
          for (const waiter of this.resultWaiters) waiter();
        } else if (event.type === "error") {
          workerError = true;
          record.error = { code: event.code, message: event.message };
          record.diagnostics = event.database
            ? [
                databaseDiagnostic(event.database, {
                  file: record.file,
                  sourceRevision: record.sourceRevision,
                  mode: request.mode,
                  source: source.source,
                  ...(sql === undefined ? {} : { sql }),
                  ...(sqlOffsets === undefined ? {} : { offsets: sqlOffsets }),
                }),
              ]
            : [];
        } else if (event.type === "done") completed = true;
      });
      const payload: WorkerRequest = {
        resultDirectory: runDirectory,
        config: this.loaded.file,
        ...(this.target ? { target: this.target } : {}),
        entry,
        mode: request.mode,
        ...(request.exportName ? { exportName: request.exportName } : {}),
        ...(boundValues ? { values: boundValues } : {}),
        ...(sql === undefined ? {} : { sql }),
        readOnly: request.readOnly !== false,
        limits: this.limits,
        files,
      };
      child.send(payload);
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolvePromise());
      });
      clearTimeout(deadline);
      record.timings.workerMs = performance.now() - workerStarted;
      record.status =
        record.error?.code === "OUTCOME_UNKNOWN"
          ? "outcome-unknown"
          : record.error?.code === "CANCELLED"
            ? request.mode === "sql"
              ? "cancelled"
              : "outcome-unknown"
            : controller.signal.aborted
              ? "outcome-unknown"
              : completed && !workerError
                ? "succeeded"
                : "failed";
      if (record.status === "failed" && !record.error)
        record.error = { code: "WORKER_EXIT", message: "Worker exited before confirming completion" };
    } finally {
      await rm(entry, { force: true });
      for (const waiter of this.resultWaiters) waiter();
    }
  }
}
