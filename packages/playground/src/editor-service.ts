import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EditorLspClient } from "./editor-lsp.js";
import { contentHash, WorkspaceError, type WorkspaceFiles } from "./files.js";

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
async function boundedRead(path: string, limit = 2 * 1024 * 1024): Promise<string> {
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new WorkspaceError("EDITOR_PATH", "Definition path changed", 409);
  const before = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || !info.isFile() || info.size > limit)
      throw new WorkspaceError("EDITOR_LIMIT", "Definition document exceeds its limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total > limit) throw new WorkspaceError("EDITOR_LIMIT", "Definition document exceeds its limit");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}
async function packageRoot(root: string, name: string): Promise<string | undefined> {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/u.test(name)) return undefined;
  let current = root;
  while (true) {
    const directory = join(current, "node_modules", name);
    try {
      const metadata = JSON.parse(await boundedRead(await realpath(join(directory, "package.json")), 128 * 1024));
      if (metadata.name === name) return await realpath(directory);
    } catch {
      /* Try ancestor inside project repository only. */
    }
    if (
      await lstat(join(current, ".git")).then(
        () => true,
        () => false,
      )
    )
      break;
    const parent = dirname(current);
    if (parent === current) break;
    // Without a repository marker, never search beyond the selected project.
    let repo = parent;
    let found = false;
    while (dirname(repo) !== repo) {
      if (
        await lstat(join(repo, ".git")).then(
          () => true,
          () => false,
        )
      ) {
        found = true;
        break;
      }
      repo = dirname(repo);
    }
    if (!found) break;
    current = parent;
  }
  return undefined;
}
interface WorkingCopy {
  readonly file: string;
  readonly source: string;
  readonly revision: string;
}
function languageId(file: string): string {
  if (file.endsWith(".sql")) return "sql";
  if (file.endsWith(".jsx")) return "javascriptreact";
  if (/\.[cm]?js$/u.test(file)) return "javascript";
  return file.endsWith(".tsx") ? "typescriptreact" : "typescript";
}
export interface EditorRoutesOptions {
  readonly files: WorkspaceFiles;
  readonly configFile: string;
  readonly projectFile?: string;
  readonly schemaFile: string;
  readonly identity?: () => unknown;
  /** Test-only explicit installed companion entrypoint. Production discovers the project-local package. */
  readonly companionFile?: string;
  readonly timeoutMs?: number;
}
/** Optional process bridge: stable playground has no dependency on the experimental server. */
export class EditorRoutes {
  private client: EditorLspClient | undefined;
  private starting: Promise<Record<string, unknown> | undefined> | undefined;
  private initialization: Record<string, unknown> | undefined;
  private readonly documents = new Map<string, { hash: string; version: number }>();
  private readonly latest = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private globalQueue: Promise<unknown> = Promise.resolve();
  private readonly dirtyDocuments = new Set<string>();
  private readonly definitions = new Map<string, { path: string; uri: string; file: string; revision: string }>();
  private schemaStamp: string | undefined;
  private stopped = false;
  private retryAt = 0;
  private pendingRequests = 0;
  private retryFailure = false;
  constructor(private readonly options: EditorRoutesOptions) {}
  private async start(): Promise<Record<string, unknown> | undefined> {
    if (this.stopped) throw new WorkspaceError("EDITOR_CLOSED", "Editor service is closed", 503);
    if (this.client !== undefined && !this.client.isAlive) {
      await this.client.close();
      this.client = undefined;
      this.starting = undefined;
      this.initialization = undefined;
      this.documents.clear();
      this.dirtyDocuments.clear();
      this.retryFailure = true;
      this.retryAt = Date.now() + 1000;
      throw new WorkspaceError("EDITOR_SERVER", "Language server stopped; retry after it restarts", 503);
    }
    if (this.starting === undefined && Date.now() < this.retryAt) {
      if (this.retryFailure) throw new WorkspaceError("EDITOR_SERVER", "Language server is restarting", 503);
      return undefined;
    }
    this.starting ??= (async () => {
      let entry = this.options.companionFile;
      if (entry === undefined) {
        const root = await packageRoot(this.options.files.root, "@typed-sql/language-server");
        if (root === undefined) return undefined;
        const metadata = JSON.parse(await boundedRead(join(root, "package.json"), 128 * 1024));
        const bin = metadata.bin?.["typed-sql-language-server"];
        if (typeof bin !== "string") return undefined;
        entry = await realpath(resolve(root, bin));
        if (!inside(root, entry)) return undefined;
      }
      if (this.stopped) throw new WorkspaceError("EDITOR_CLOSED", "Editor service is closed", 503);
      this.client = new EditorLspClient(process.execPath, [entry], this.options.files.root, this.options.timeoutMs);
      const initialized = await this.client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.options.files.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.options.files.root).href, name: "Project" }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            diagnostic: {},
            completion: {
              completionItem: {
                snippetSupport: false,
                resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
              },
            },
          },
        },
        initializationOptions: {
          runExternalCode: true,
          typedSql: {
            configPath: this.options.configFile,
            projectFile: this.options.projectFile,
            schemaPath: this.options.schemaFile,
            analysisDebounceMs: 0,
            protocol: { version: 1, capabilities: ["analysis-identity", "diagnostic-fixes", "status"] },
          },
        },
      });
      if (this.stopped) throw new WorkspaceError("EDITOR_CLOSED", "Editor service is closed", 503);
      this.initialization = object(initialized) ? initialized : {};
      this.client.notify("initialized", {});
      this.retryFailure = false;
      return this.initialization;
    })();
    try {
      const result = await this.starting;
      if (result === undefined) {
        this.starting = undefined;
        this.retryAt = Date.now() + 1000;
      }
      return result;
    } catch (error) {
      await this.client?.close();
      this.client = undefined;
      this.starting = undefined;
      this.documents.clear();
      this.dirtyDocuments.clear();
      this.retryAt = Date.now() + 1000;
      this.retryFailure = true;
      throw error;
    }
  }
  async handle(body: unknown, trusted: boolean): Promise<unknown> {
    if (!trusted)
      throw new WorkspaceError("TRUST_REQUIRED", "Trust this project before starting its local language server", 403);
    if (!object(body)) throw new WorkspaceError("EDITOR_INPUT", "Expected an editor request");
    if (body.method === "readDefinition") return this.readDefinition(body.token);
    const allowed = ["diagnostics", "hover", "completion", "completionResolve", "definition", "codeAction"];
    if (
      typeof body.method !== "string" ||
      !allowed.includes(body.method) ||
      typeof body.file !== "string" ||
      typeof body.source !== "string" ||
      typeof body.revision !== "string" ||
      Buffer.byteLength(body.source) > 512 * 1024
    )
      throw new WorkspaceError("EDITOR_INPUT", "Expected a bounded source, file, revision, and supported method");
    if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024)
      throw new WorkspaceError(
        "EDITOR_LIMIT",
        "The complete editor context exceeds 1 MiB. Save some working copies and retry",
      );
    const file = body.file;
    const source = body.source;
    const revision = body.revision;
    const sourceHash = contentHash(source);
    const copies: WorkingCopy[] = [];
    if (body.workingCopies !== undefined && !Array.isArray(body.workingCopies))
      throw new WorkspaceError("EDITOR_CONTEXT", "Working copies must be a complete array");
    const seen = new Set<string>([file]);
    for (const copy of (body.workingCopies ?? []) as unknown[]) {
      if (
        !object(copy) ||
        typeof copy.file !== "string" ||
        typeof copy.source !== "string" ||
        typeof copy.revision !== "string" ||
        seen.has(copy.file) ||
        Buffer.byteLength(copy.source) > 512 * 1024
      )
        throw new WorkspaceError(
          "EDITOR_CONTEXT",
          "Working copies require unique other files, bounded sources, and saved revisions",
        );
      seen.add(copy.file);
      copies.push({ file: copy.file, source: copy.source, revision: copy.revision });
    }
    if (copies.length > 63)
      throw new WorkspaceError(
        "EDITOR_LIMIT",
        "Keep at most 63 other dirty working copies open for editor intelligence",
      );
    copies.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const workingCopyHash = contentHash(JSON.stringify(copies));
    const contextKey = `${sourceHash}:${workingCopyHash}`;

    if (this.pendingRequests >= 64) throw new WorkspaceError("EDITOR_BUSY", "Too many editor requests", 429);
    this.pendingRequests += 1;
    this.latest.set(file, contextKey);
    const previous = this.globalQueue;
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const path = await this.options.files.path(file);
        const uri = pathToFileURL(path).href;
        const assertCurrent = async () => {
          if (this.latest.get(file) !== contextKey || (await this.options.files.read(file)).revision !== revision)
            throw new WorkspaceError("EDITOR_STALE", "Source changed; request fresh editor information", 409);
        };
        const assertCopies = async () => {
          const paths = new Set([await realpath(path)]);
          for (const copy of copies) {
            const copyPath = await realpath(await this.options.files.path(copy.file));
            if (paths.has(copyPath))
              throw new WorkspaceError("EDITOR_CONTEXT", "Working copies must identify unique other project files");
            paths.add(copyPath);
            if ((await this.options.files.read(copy.file)).revision !== copy.revision)
              throw new WorkspaceError(
                "EDITOR_STALE",
                "A working copy changed on disk; reload it before requesting editor information",
                409,
              );
          }
        };
        await assertCopies();
        await assertCurrent();
        const identity = this.options.identity?.();
        const stamp = contentHash(await boundedRead(await realpath(this.options.schemaFile), 16 * 1024 * 1024));
        const base = {
          file,
          revision,
          uri,
          sourceHash,
          workingCopyHash,
          schemaIdentity: identity,
          projectSnapshotHash: stamp,
        };
        let initialization: Record<string, unknown> | undefined;
        try {
          initialization = await this.start();
        } catch {
          return {
            ...base,
            version: 0,
            result: null,
            diagnostics: [],
            status: {
              state: "failed",
              message:
                "The project language server could not start. Check its pinned TypeScript preview installation, then retry.",
            },
          };
        }
        if (initialization === undefined)
          return {
            ...base,
            version: 0,
            result: null,
            diagnostics: [],
            status: {
              state: "unavailable",
              message:
                "Install @typed-sql/language-server in this project to enable editor intelligence. Analysis uses the project schema snapshot.",
            },
          };
        const client = this.client!;
        if (this.schemaStamp !== undefined && stamp !== this.schemaStamp) {
          client.notify("workspace/didChangeWatchedFiles", {
            changes: [{ uri: pathToFileURL(this.options.schemaFile).href, type: 2 }],
          });
        }
        this.schemaStamp = stamp;
        const protectedFiles = new Set([file, ...copies.map((copy) => copy.file)]);
        const desiredDirty = new Set(copies.map((copy) => copy.file));
        if (sourceHash !== revision) desiredDirty.add(file);
        for (const old of this.dirtyDocuments) {
          if (desiredDirty.has(old)) continue;
          const oldUri = pathToFileURL(resolve(this.options.files.root, old)).href;
          client.notify("textDocument/didClose", { textDocument: { uri: oldUri } });
          this.documents.delete(old);
          this.dirtyDocuments.delete(old);
          // Await the document queue, including restoring its saved disk source.
          await client.request("textDocument/diagnostic", { textDocument: { uri: oldUri } });
        }
        for (const copy of copies) {
          const copyUri = await this.syncDocument(copy, protectedFiles);
          this.dirtyDocuments.add(copy.file);
          // The target may import this document. Commit its overlay before querying the target.
          await client.request("textDocument/diagnostic", { textDocument: { uri: copyUri } });
        }
        await this.syncDocument({ file, source, revision }, protectedFiles);
        if (sourceHash !== revision) this.dirtyDocuments.add(file);
        else this.dirtyDocuments.delete(file);
        const document = this.documents.get(file)!;
        const params: Record<string, unknown> = { textDocument: { uri } };
        if (["hover", "completion", "definition"].includes(body.method as string)) {
          if (
            !object(body.position) ||
            !Number.isSafeInteger(body.position.line) ||
            !Number.isSafeInteger(body.position.character) ||
            (body.position.line as number) < 0 ||
            (body.position.character as number) < 0
          )
            throw new WorkspaceError("EDITOR_POSITION", "Expected a UTF-16 source position");
          params.position = body.position;
        }
        if (body.method === "completion") params.context = body.context;
        if (body.method === "codeAction") {
          params.range = body.range;
          params.context = body.context ?? { diagnostics: [] };
        }
        const diagnosticResult = await client.request("textDocument/diagnostic", { textDocument: { uri } });
        const diagnostics =
          object(diagnosticResult) && Array.isArray(diagnosticResult.items) ? diagnosticResult.items : [];
        let result: unknown = diagnostics;
        if (body.method !== "diagnostics")
          result = await client.request(
            body.method === "completionResolve" ? "completionItem/resolve" : `textDocument/${body.method}`,
            body.method === "completionResolve" ? body.item : params,
          );
        await assertCurrent();
        await assertCopies();
        const now = contentHash(await boundedRead(await realpath(this.options.schemaFile), 16 * 1024 * 1024));
        if (now !== stamp || JSON.stringify(this.options.identity?.()) !== JSON.stringify(identity))
          throw new WorkspaceError("EDITOR_STALE", "Schema changed; request fresh editor information", 409);
        if (body.method === "definition") result = await this.definitionLocations(result);
        return {
          ...base,
          version: document.version,
          result,
          diagnostics,
          status: {
            state: "ready",
            server: initialization.serverInfo,
            capabilities: initialization.capabilities,
            message: "Analysis uses the project schema snapshot.",
          },
        };
      });
    this.globalQueue = operation;
    this.queues.set(file, operation);
    try {
      return await operation;
    } finally {
      this.pendingRequests -= 1;
      if (this.queues.get(file) === operation) {
        this.queues.delete(file);
        this.latest.delete(file);
      }
    }
  }
  private async syncDocument(copy: WorkingCopy, protectedFiles: ReadonlySet<string>): Promise<string> {
    const client = this.client!;
    const uri = pathToFileURL(await this.options.files.path(copy.file)).href;
    const hash = contentHash(copy.source);
    let document = this.documents.get(copy.file);
    if (document === undefined) {
      if (this.documents.size >= 64) {
        const oldest = [...this.documents.keys()].find((file) => !protectedFiles.has(file));
        if (oldest === undefined)
          throw new WorkspaceError("EDITOR_LIMIT", "The complete working-copy context exceeds the open document limit");
        client.notify("textDocument/didClose", {
          textDocument: { uri: pathToFileURL(resolve(this.options.files.root, oldest)).href },
        });
        this.documents.delete(oldest);
        this.dirtyDocuments.delete(oldest);
      }
      document = { hash, version: 1 };
      this.documents.set(copy.file, document);
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(copy.file), version: document.version, text: copy.source },
      });
    } else if (document.hash !== hash) {
      document = { hash, version: document.version + 1 };
      this.documents.set(copy.file, document);
      client.notify("textDocument/didChange", {
        textDocument: { uri, version: document.version },
        contentChanges: [{ text: copy.source }],
      });
    }
    return uri;
  }
  private async authorizedDefinition(uri: string): Promise<{ path: string; file: string } | undefined> {
    if (!uri.startsWith("file:")) return undefined;
    let path: string;
    try {
      path = await realpath(fileURLToPath(uri));
    } catch {
      return undefined;
    }
    const schema = await realpath(this.options.schemaFile);
    if (path === schema) return { path, file: relative(this.options.files.root, path) };
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path)) return undefined;
    const file = relative(this.options.files.root, path);
    try {
      if ((await realpath(await this.options.files.path(file))) === path) return { path, file };
    } catch {
      /* Read-only installed dependency below. */
    }
    if (!/\.d\.[cm]?ts$/u.test(path)) return undefined;
    let directory = dirname(path);
    while (dirname(directory) !== directory) {
      try {
        const metadata = JSON.parse(await boundedRead(await realpath(join(directory, "package.json")), 128 * 1024));
        const root = await packageRoot(this.options.files.root, metadata.name);
        if (root !== undefined && root === directory && inside(root, path))
          return { path, file: `[dependency] ${metadata.name}/${relative(root, path)}` };
      } catch {
        /* Find containing package. */
      }
      directory = dirname(directory);
    }
    return undefined;
  }
  private async definitionLocations(result: unknown): Promise<unknown> {
    const values = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
    const locations = [];
    for (const value of values.slice(0, 64)) {
      if (!object(value)) continue;
      const uri =
        typeof value.uri === "string" ? value.uri : typeof value.targetUri === "string" ? value.targetUri : undefined;
      if (uri === undefined) continue;
      const target = await this.authorizedDefinition(uri);
      if (target === undefined) continue;
      const token = randomUUID();
      if (this.definitions.size >= 128) this.definitions.delete(this.definitions.keys().next().value!);
      const revision = contentHash(await boundedRead(target.path));
      this.definitions.set(token, { ...target, uri, revision });
      locations.push({
        ...value,
        uri,
        range: value.range ?? value.targetSelectionRange,
        file: target.file,
        token,
        readOnly: true,
      });
    }
    return locations;
  }
  private async readDefinition(token: unknown): Promise<unknown> {
    const target = typeof token === "string" ? this.definitions.get(token) : undefined;
    if (target === undefined || (await this.authorizedDefinition(target.uri))?.path !== target.path)
      throw new WorkspaceError("EDITOR_DEFINITION", "Request a fresh definition before opening this document", 403);
    const source = await boundedRead(target.path);
    const revision = contentHash(source);
    if (revision !== target.revision) {
      this.definitions.delete(token as string);
      throw new WorkspaceError(
        "EDITOR_STALE",
        "Definition changed; request a fresh definition before opening this document",
        409,
      );
    }
    return { file: target.file, uri: target.uri, source, revision, readOnly: true };
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.client?.close();
    await this.starting?.catch(() => undefined);
    this.definitions.clear();
    this.documents.clear();
    this.dirtyDocuments.clear();
  }
}
