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
import { contentHash, WorkspaceError, type WorkspaceFiles } from "./files.js";
import { analyzeSql, bindSql } from "./sql.js";
import type { WireValue } from "./values.js";
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
  schemaHash: string | null;
  readonly typePolicyHash: string;
  finishedAt?: string;
  status: "checking" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "outcome-unknown";
  results: Extract<WorkerEvent, { type: "result" }>[];
  logs: string;
  error?: { readonly code: string; readonly message: string };
}

/** Static export discovery operates on transpiled syntax, never importing the project file. */
export async function callableExports(source: string): Promise<readonly string[]> {
  const js = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
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
      schemaHash: this.expectedSchemaHash ?? null,
      typePolicyHash: calculateTypePolicyHash(
        this.loaded.config.typePolicy ?? this.loaded.config.dialect.defaultTypePolicy,
      ),
      status: "checking",
      results: [],
      logs: "",
    };
    this.records.set(record.id, record);
    this.requests.set(request.requestId, { fingerprint, recordId: record.id });
    while (this.records.size > 10) this.records.delete(this.records.keys().next().value!);
    const active = { record, controller: new AbortController() };
    this.active = active;
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
        if (this.active === active) this.active = undefined;
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
  async close(): Promise<void> {
    const active = this.active;
    if (!active) return;
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
  }
  private async execute(
    request: RunRequest,
    active: { record: RunRecord; controller: AbortController; child?: ChildProcess },
  ): Promise<void> {
    const { record, controller } = active;
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
      boundValues = bindSql(sqlAnalysis, request.values ?? []);
      captured.set(await this.files.path(request.file), source.source);
    } else {
      if (!/\.[cm]?ts$/u.test(request.file)) throw new WorkspaceError("RUN_MODE", "Select a TypeScript file");
      if (request.mode === "export" && !(await callableExports(source.source)).includes(request.exportName ?? "run"))
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
    const runDirectory = join(await realpath(this.loaded.directory), ".typed-sql", "playground", "runs", record.id);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
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
                        loader: args.path.endsWith(".sql")
                          ? "text"
                          : args.path.endsWith(".tsx")
                            ? "tsx"
                            : /\.[cm]?js$/u.test(args.path)
                              ? "js"
                              : "ts",
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
                    loader:
                      transformed?.language ??
                      (args.path.endsWith(".sql")
                        ? "js"
                        : args.path.endsWith(".tsx")
                          ? "tsx"
                          : /\.[cm]?js$/u.test(args.path)
                            ? "js"
                            : "ts"),
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
      const deadline = setTimeout(() => {
        controller.abort();
        if (child.connected) child.send({ cancel: true });
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        record.status = "cancelling";
      }, this.limits.timeoutMs);
      deadline.unref();
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
        if (event.type === "local-error") {
          process.stderr.write(`Playground worker: ${event.message}\n`);
        } else if (event.type === "result") {
          if (
            record.results.length < 10 &&
            Buffer.byteLength(JSON.stringify([...record.results, event])) <= this.limits.maxResultBytes
          )
            record.results.push(event);
          else {
            workerError = true;
            record.error = { code: "RESULT_LIMIT", message: "Result transport limit reached" };
            controller.abort();
            child.kill();
          }
        } else if (event.type === "error") {
          workerError = true;
          record.error = { code: event.code, message: event.message };
        } else if (event.type === "done") completed = true;
      });
      const payload: WorkerRequest = {
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
      await rm(runDirectory, { recursive: true, force: true });
    }
  }
}
