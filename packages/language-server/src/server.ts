#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { cwd, stderr, stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertTypeScriptPreviewVersion, type BridgeAnalysis } from "@typed-sql/ts-bridge";
import { typescriptPreviewCliPath } from "@typed-sql/ts-bridge/native-lsp";
import { TYPESCRIPT_PREVIEW_VERSION } from "@typed-sql/ts-bridge/native-preview";
import {
  type CancellationToken,
  createMessageConnection,
  type MessageConnection,
  NullLogger,
  ResponseError,
} from "vscode-jsonrpc/node";
import { TextDocument, type TextDocumentContentChangeEvent } from "vscode-languageserver-textdocument";
import { extendTypeScriptCapabilities } from "./capabilities.js";
import {
  negotiateTypedSqlProtocol,
  settingsFrom,
  type TYPED_SQL_PROTOCOL_CAPABILITIES,
  TYPED_SQL_STATUS_REQUEST,
  type TypedSqlLanguageServerStatus,
  TypedSqlLanguageService,
  TypedSqlProtocolCompatibilityError,
  type TypedSqlProtocolNegotiation,
} from "./index.js";
import { mapProtocolCoordinates } from "./protocol-mapping.js";
import { ResolveContexts, resolveMethodFor } from "./resolve-context.js";
import { projectSemanticTokens, SemanticTokenResults } from "./semantic-tokens.js";

interface Position {
  readonly line: number;
  readonly character: number;
}

interface InitializeParams {
  readonly rootUri?: string | null;
  readonly workspaceFolders?: readonly { readonly uri: string }[] | null;
  readonly initializationOptions?: unknown;
  readonly [key: string]: unknown;
}

interface DidOpenParams {
  readonly textDocument: {
    readonly uri: string;
    readonly languageId: string;
    readonly version: number;
    readonly text: string;
  };
}

interface DidChangeParams {
  readonly textDocument: { readonly uri: string; readonly version: number };
  readonly contentChanges: readonly TextDocumentContentChangeEvent[];
}

interface DidCloseParams {
  readonly textDocument: { readonly uri: string };
}

interface DocumentState {
  readonly original: TextDocument;
  readonly transformed: TextDocument;
  readonly analysis?: BridgeAnalysis;
  readonly service: TypedSqlLanguageService;
  readonly virtualVersion: number;
}

type JsonObject = Record<string, unknown>;
type MappingDirection = "source-to-virtual" | "virtual-to-source";

interface WatchedFileChange {
  readonly uri: string;
  readonly type: number;
}

class AnalysisCancellation {
  #cancelled = false;

  get isCancellationRequested(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    this.#cancelled = true;
  }
}

assertTypeScriptPreviewVersion();
const previewCli = process.env.TYPED_SQL_TYPESCRIPT_PREVIEW_CLI ?? typescriptPreviewCliPath();
const preview = spawn(process.execPath, [previewCli, "--lsp", "--stdio"], {
  cwd: cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});
let previewFailure: Error | undefined;
let previewStderr = "";
let stopping = false;
const previewFailureWaiters = new Set<(error: Error) => void>();

function previewError(cause: string): Error {
  return new Error(
    [
      "typed-sql could not start or communicate with its pinned TypeScript preview process.",
      `Preview: TypeScript ${TYPESCRIPT_PREVIEW_VERSION}`,
      `CLI: ${previewCli}`,
      `Cause: ${cause}`,
      previewStderr.length === 0 ? "" : "The preview process reported stderr output.",
      "Reinstall @typed-sql/language-server in the workspace and restart the editor.",
    ]
      .filter((part) => part.length > 0)
      .join(" "),
  );
}

function failPreview(error: Error): void {
  previewFailure ??= error;
  for (const reject of previewFailureWaiters) reject(previewFailure);
  previewFailureWaiters.clear();
  stderr.write(`${previewFailure.message}\n`);
}

const previewStarted = new Promise<void>((resolvePreview, rejectPreview) => {
  preview.once("spawn", resolvePreview);
  preview.once("error", (error) => {
    const failure = previewError(error.message);
    failPreview(failure);
    rejectPreview(failure);
  });
});
const previewReady = Promise.all([
  previewStarted,
  access(previewCli).catch((error: unknown) => {
    const failure = previewError(error instanceof Error ? error.message : String(error));
    failPreview(failure);
    throw failure;
  }),
]).then(() => undefined);
const client = createMessageConnection(stdin, stdout, NullLogger);
const typescript: MessageConnection = createMessageConnection(preview.stdout, preview.stdin, NullLogger);
const sourceDocuments = new Map<string, TextDocument>();
const documents = new Map<string, DocumentState>();
const virtualDocuments = new Map<string, DocumentState>();
const nativeDiagnostics = new Map<string, readonly unknown[]>();
const projectFailureReports = new Map<string, JsonObject>();
let pullDiagnostics = false;
let diagnosticRefreshSupported = false;
const semanticTokenResults = new SemanticTokenResults();
const resolveContexts = new ResolveContexts<DocumentState>();
const pendingDocuments = new Map<string, Promise<void>>();
const latestDocumentVersions = new Map<string, number>();
const documentAnalysisTokens = new Map<string, AnalysisCancellation>();
const LSP_REQUEST_CANCELLED = -32800;
const LSP_CONTENT_MODIFIED = -32801;
const LSP_PROTOCOL_UNSUPPORTED = -32098;
let workspaceReady: Promise<void> = Promise.resolve();
let workspaceRoots: readonly string[] = [resolve(cwd())];
let services = new Map([[workspaceRoots[0]!, new TypedSqlLanguageService(workspaceRoots[0]!)]]);
let negotiatedProtocol: TypedSqlProtocolNegotiation = negotiateTypedSqlProtocol(undefined);

preview.stderr.on("data", (chunk: Buffer | string) => {
  void chunk;
  previewStderr = "reported";
  stderr.write(`[typed-sql/typescript-${TYPESCRIPT_PREVIEW_VERSION}] preview process reported stderr output\n`);
});

async function nativeRequest<T = unknown>(method: string, params?: unknown, token?: CancellationToken): Promise<T> {
  if (previewFailure !== undefined) throw previewFailure;
  if (resolveMethodFor(method) !== undefined && isObject(params)) {
    // Keep resolvable items in the final result so every item receives a source
    // identity. Otherwise partial-result progress could bypass context wrapping.
    const { partialResultToken: _partial, ...completeParams } = params;
    params = completeParams;
  }
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolveFailure, reject) => {
    rejectFailure = reject;
    previewFailureWaiters.add(reject);
  });
  try {
    const request =
      params === undefined
        ? token === undefined
          ? typescript.sendRequest<T>(method)
          : typescript.sendRequest<T>(method, token)
        : token === undefined
          ? typescript.sendRequest<T>(method, params)
          : typescript.sendRequest<T>(method, params, token);
    return await Promise.race([request, failure]);
  } finally {
    previewFailureWaiters.delete(rejectFailure);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspaceDirectories(params: InitializeParams): readonly string[] {
  const folderUris = params.workspaceFolders?.map((folder) => folder.uri);
  const uris = folderUris !== undefined && folderUris.length > 0 ? folderUris : [params.rootUri];
  const directories = uris.flatMap((uri) =>
    typeof uri === "string" && uri.startsWith("file:") ? [resolve(fileURLToPath(uri))] : [],
  );
  return directories.length === 0 ? [resolve(cwd())] : [...new Set(directories)];
}

function contains(root: string, fileName: string): boolean {
  const path = relative(root, fileName);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function serviceForUri(uri?: string): TypedSqlLanguageService {
  const fileName = uri?.startsWith("file:") === true ? fileURLToPath(uri) : undefined;
  const root =
    fileName === undefined
      ? workspaceRoots[0]
      : workspaceRoots
          .filter((candidate) => contains(candidate, fileName))
          .sort((left, right) => right.length - left.length)[0];
  return services.get(root ?? workspaceRoots[0]!)!;
}

async function configureServices(roots: readonly string[], settings: ReturnType<typeof settingsFrom>): Promise<void> {
  const previous = services;
  workspaceRoots = roots;
  services = new Map(roots.map((root) => [root, new TypedSqlLanguageService(root, settings)]));
  await Promise.all([...previous.values()].map(async (service) => service.close()));
}

function sourceOffsetToVirtual(state: DocumentState, offset: number): number {
  if (state.analysis === undefined) return offset;
  return (
    offset +
    state.analysis.insertions.reduce(
      (shift, insertion) => shift + (insertion.position < offset ? insertion.length : 0),
      0,
    )
  );
}

function virtualOffsetToSource(state: DocumentState, offset: number): number {
  if (state.analysis === undefined) return offset;
  let shift = 0;
  for (const insertion of state.analysis.insertions) {
    const virtualStart = insertion.position + shift;
    if (offset <= virtualStart) return offset - shift;
    if (offset <= virtualStart + insertion.length) return insertion.position;
    shift += insertion.length;
  }
  return offset - shift;
}

function mapPosition(state: DocumentState, position: Position, direction: MappingDirection): Position {
  if (direction === "source-to-virtual") {
    return state.transformed.positionAt(sourceOffsetToVirtual(state, state.original.offsetAt(position)));
  }
  return state.original.positionAt(virtualOffsetToSource(state, state.transformed.offsetAt(position)));
}

function stateFor(value: JsonObject, fallback?: DocumentState): DocumentState | undefined {
  const uri =
    typeof value.uri === "string"
      ? value.uri
      : isObject(value.textDocument) && typeof value.textDocument.uri === "string"
        ? value.textDocument.uri
        : undefined;
  return uri === undefined ? fallback : (documents.get(uri) ?? virtualDocuments.get(uri));
}

function documentUri(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.uri === "string") return value.uri;
  return isObject(value.textDocument) && typeof value.textDocument.uri === "string"
    ? value.textDocument.uri
    : undefined;
}

function watchedFileChanges(value: unknown): readonly WatchedFileChange[] | undefined {
  if (!isObject(value) || !Array.isArray(value.changes)) return undefined;
  return value.changes.filter(
    (change): change is WatchedFileChange =>
      isObject(change) && typeof change.uri === "string" && typeof change.type === "number",
  );
}

function queueDocument(uri: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingDocuments.get(uri) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(operation)
    .catch(async (error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      nativeDiagnostics.delete(uri);
      const diagnostic = projectFailureDiagnostic(error);
      if (sourceDocuments.has(uri)) projectFailureReports.set(uri, diagnostic);
      await client.sendNotification("textDocument/publishDiagnostics", {
        uri,
        ...(latestDocumentVersions.get(uri) === undefined ? {} : { version: latestDocumentVersions.get(uri) }),
        diagnostics: [diagnostic],
      });
      requestDiagnosticRefresh();
    });
  pendingDocuments.set(uri, pending);
  return pending.finally(() => {
    if (pendingDocuments.get(uri) === pending) pendingDocuments.delete(uri);
  });
}

function beginDocumentAnalysis(uri: string, cancelPrevious = true): AnalysisCancellation {
  if (cancelPrevious) documentAnalysisTokens.get(uri)?.cancel();
  const token = new AnalysisCancellation();
  documentAnalysisTokens.set(uri, token);
  return token;
}

function queueWorkspace(operation: () => Promise<void>): Promise<void> {
  workspaceReady = workspaceReady
    .catch(() => undefined)
    .then(operation)
    .catch(async (error: unknown) => {
      for (const [uri, state] of documents) {
        nativeDiagnostics.delete(uri);
        const diagnostic = projectFailureDiagnostic(error);
        if (sourceDocuments.has(uri)) projectFailureReports.set(uri, diagnostic);
        await client.sendNotification("textDocument/publishDiagnostics", {
          uri,
          version: state.original.version,
          diagnostics: [diagnostic],
        });
      }
      requestDiagnosticRefresh();
    });
  return workspaceReady;
}

function projectFailureDiagnostic(error: unknown): JsonObject {
  const kind = error instanceof Error && error.name.length > 0 ? error.name : "Error";
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: 1,
    source: "typed-sql",
    code: "TYPED_SQL_PROJECT_UNAVAILABLE",
    message: `typed-sql analysis is unavailable (${kind}). Run typed-sql doctor and retry after correcting the project, config, grammar, or schema.`,
  };
}

async function waitForDocument(uri: string, token: CancellationToken): Promise<void> {
  const pending = pendingDocuments.get(uri);
  if (pending === undefined) return;
  if (token.isCancellationRequested) throw new ResponseError(LSP_REQUEST_CANCELLED, "Request cancelled");
  let cancellation: { dispose(): void } | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        cancellation = token.onCancellationRequested(() => {
          reject(new ResponseError(LSP_REQUEST_CANCELLED, "Request cancelled"));
        });
      }),
    ]);
  } finally {
    cancellation?.dispose();
  }
}

function mapProtocolValue(value: unknown, direction: MappingDirection, fallback?: DocumentState): unknown {
  return mapProtocolCoordinates(
    value,
    {
      lookup: (uri) => documents.get(uri) ?? virtualDocuments.get(uri),
      position: (state, position) => mapPosition(state, position, direction),
      version: (state, version) => {
        ensureStateCurrent(state);
        const expected = direction === "source-to-virtual" ? state.original.version : state.virtualVersion;
        if (version !== expected) {
          throw new ResponseError(LSP_CONTENT_MODIFIED, "Document version does not match the mapped source snapshot");
        }
        return direction === "source-to-virtual" ? state.virtualVersion : state.original.version;
      },
    },
    fallback,
  );
}

function wrapResolveResults(method: string, result: unknown, state: DocumentState | undefined): unknown {
  return state === undefined ? result : resolveContexts.response(method, result, state.original.uri, state);
}

async function createState(
  original: TextDocument,
  previous?: DocumentState,
  cancellation?: AnalysisCancellation,
): Promise<DocumentState> {
  const service = serviceForUri(original.uri);
  const analysis = await service.analysis(original, cancellation);
  if (cancellation?.isCancellationRequested === true) {
    const error = new Error("typed-sql document analysis superseded");
    error.name = "AbortError";
    throw error;
  }
  resolveContexts.delete(original.uri);
  const virtualVersion = previous === undefined ? original.version : previous.virtualVersion + 1;
  const transformed = TextDocument.create(
    original.uri,
    original.languageId,
    virtualVersion,
    analysis?.transformedSource ?? original.getText(),
  );
  return {
    original,
    transformed,
    ...(analysis === undefined ? {} : { analysis }),
    service,
    virtualVersion,
  };
}

function negotiated(capability: (typeof TYPED_SQL_PROTOCOL_CAPABILITIES)[number]): boolean {
  return negotiatedProtocol.capabilities.includes(capability);
}

function ensureStateCurrent(state: DocumentState | undefined): void {
  if (state === undefined) return;
  const current = documents.get(state.original.uri) ?? virtualDocuments.get(state.original.uri);
  const sourceVersion = latestDocumentVersions.get(state.original.uri);
  if (
    current !== state ||
    (sourceVersion !== undefined && sourceDocuments.get(state.original.uri) !== state.original) ||
    (sourceVersion !== undefined && sourceVersion !== state.original.version) ||
    (state.analysis !== undefined && !state.service.isAnalysisCurrent(state.original, state.analysis))
  ) {
    throw new ResponseError(LSP_CONTENT_MODIFIED, "Document or typed-sql analysis identity changed during request");
  }
}

function protocolDiagnostics(diagnostics: readonly unknown[]): readonly unknown[] {
  const includeIdentity = negotiated("analysis-identity");
  const includeFixes = negotiated("diagnostic-fixes");
  if (includeIdentity && includeFixes) return diagnostics;
  return diagnostics.map((diagnostic) => {
    if (!isObject(diagnostic) || diagnostic.source !== "typed-sql" || !isObject(diagnostic.data)) return diagnostic;
    const filtered = Object.fromEntries(
      Object.entries(diagnostic.data).filter(([key]) =>
        key === "analysisRevision" || key === "identity" ? includeIdentity : includeFixes,
      ),
    );
    return { ...diagnostic, ...(Object.keys(filtered).length === 0 ? { data: undefined } : { data: filtered }) };
  });
}

async function combinedDiagnostics(state: DocumentState): Promise<readonly unknown[]> {
  return protocolDiagnostics([
    ...(nativeDiagnostics.get(state.original.uri) ?? []),
    ...(await state.service.diagnostics(state.original)),
  ]);
}

function requestDiagnosticRefresh(): void {
  // Never await a refresh from a document/workspace queue: the new pull waits
  // for that queue to finish, including when schema analysis failed.
  if (pullDiagnostics && diagnosticRefreshSupported)
    void client.sendRequest("workspace/diagnostic/refresh").catch(() => undefined);
}

async function publishCombinedDiagnostics(state: DocumentState): Promise<void> {
  if (latestDocumentVersions.get(state.original.uri) !== state.original.version) return;
  if (pullDiagnostics) {
    // Failure reports use push delivery even for pull clients. Clear that owned
    // report once analysis recovers; requesting a pull alone does not remove it.
    if (projectFailureReports.delete(state.original.uri))
      await client.sendNotification("textDocument/publishDiagnostics", {
        uri: state.original.uri,
        version: state.original.version,
        diagnostics: [],
      });
    // A typed-sql-only push would replace the client's combined pull report and
    // erase TypeScript errors. Ask it to pull again after overlay invalidation.
    // Do not await: the new pull must be able to wait for this document queue.
    requestDiagnosticRefresh();
    return;
  }
  const diagnostics = await combinedDiagnostics(state);
  if (
    latestDocumentVersions.get(state.original.uri) !== state.original.version ||
    documents.get(state.original.uri) !== state ||
    sourceDocuments.get(state.original.uri) !== state.original ||
    (state.analysis !== undefined && !state.service.isAnalysisCurrent(state.original, state.analysis))
  )
    return;
  projectFailureReports.delete(state.original.uri);
  await client.sendNotification("textDocument/publishDiagnostics", {
    uri: state.original.uri,
    version: state.original.version,
    diagnostics,
  });
}

async function refreshOpenDocuments(): Promise<void> {
  for (const [uri, original] of sourceDocuments) {
    const previous = documents.get(uri);
    const cancellation = beginDocumentAnalysis(uri);
    serviceForUri(uri).forget(uri);
    const state = await createState(original, previous, cancellation);
    documents.set(uri, state);
    nativeDiagnostics.delete(uri);
    await typescript.sendNotification(
      previous === undefined ? "textDocument/didOpen" : "textDocument/didChange",
      previous === undefined
        ? {
            textDocument: {
              uri,
              languageId: original.languageId,
              version: state.virtualVersion,
              text: state.transformed.getText(),
            },
          }
        : {
            textDocument: { uri, version: state.virtualVersion },
            contentChanges: [{ text: state.transformed.getText() }],
          },
    );
    await publishCombinedDiagnostics(state);
  }
}

async function preloadWorkspaceDocuments(): Promise<void> {
  for (const service of services.values()) {
    for (const fileName of await service.workspaceFiles()) {
      const uri = pathToFileURL(fileName).href;
      if (documents.has(uri) || virtualDocuments.has(uri)) continue;
      const text = await readFile(fileName, "utf8");
      const original = TextDocument.create(uri, /\.tsx$/u.test(fileName) ? "typescriptreact" : "typescript", 0, text);
      const state = await createState(original);
      if (documents.has(uri) || virtualDocuments.has(uri)) continue;
      if (state.analysis?.queries.length === 0 || state.analysis === undefined) continue;
      virtualDocuments.set(uri, state);
      await typescript.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: original.languageId,
          version: state.virtualVersion,
          text: state.transformed.getText(),
        },
      });
    }
  }
}

async function resetVirtualDocuments(): Promise<void> {
  for (const uri of virtualDocuments.keys()) {
    if (documents.has(uri)) {
      virtualDocuments.delete(uri);
      continue;
    }
    await typescript.sendNotification("textDocument/didClose", { textDocument: { uri } });
    serviceForUri(uri).forget(uri);
  }
  virtualDocuments.clear();
  await preloadWorkspaceDocuments();
}

client.onRequest("initialize", async (rawParams) => {
  const params = rawParams as InitializeParams;
  try {
    negotiatedProtocol = negotiateTypedSqlProtocol(params.initializationOptions);
  } catch (error) {
    if (error instanceof TypedSqlProtocolCompatibilityError) {
      throw new ResponseError(LSP_PROTOCOL_UNSUPPORTED, error.message, {
        code: error.code,
        requestedVersion: error.requestedVersion,
      });
    }
    throw error;
  }
  await previewReady;
  const roots = workspaceDirectories(params);
  await configureServices(roots, settingsFrom(params.initializationOptions));
  const result = await nativeRequest<JsonObject>("initialize", params);
  const capabilities = isObject(params.capabilities) ? params.capabilities : {};
  const textCapabilities = isObject(capabilities.textDocument) ? capabilities.textDocument : {};
  const workspaceCapabilities = isObject(capabilities.workspace) ? capabilities.workspace : {};
  pullDiagnostics =
    isObject(textCapabilities.diagnostic) &&
    isObject(result.capabilities) &&
    isObject(result.capabilities.diagnosticProvider);
  diagnosticRefreshSupported =
    isObject(workspaceCapabilities.diagnostics) && workspaceCapabilities.diagnostics.refreshSupport === true;
  return {
    ...result,
    capabilities: extendTypeScriptCapabilities(result.capabilities),
    serverInfo: {
      name: "typed-sql + TypeScript preview",
      version: TYPESCRIPT_PREVIEW_VERSION,
    },
    typedSql: { protocol: negotiatedProtocol },
  };
});

client.onRequest("shutdown", async () => {
  const result = await nativeRequest("shutdown");
  await Promise.all([...services.values()].map(async (service) => service.close()));
  return result;
});

client.onNotification("initialized", async (params) => {
  workspaceReady = (async () => {
    await typescript.sendNotification("initialized", params);
    await preloadWorkspaceDocuments();
  })();
  await workspaceReady;
});

client.onRequest("textDocument/completion", async (rawParams, token) => {
  await workspaceReady;
  const params = rawParams as JsonObject;
  const uri = documentUri(params);
  if (uri !== undefined) await waitForDocument(uri, token);
  const state = stateFor(params);
  if (state !== undefined && isObject(params.position)) {
    const items = await state.service.completions(state.original, params.position as unknown as Position, token);
    ensureStateCurrent(state);
    if (items.length > 0) return { isIncomplete: false, items };
  }
  const mapped = mapProtocolValue(params, "source-to-virtual", state);
  const result = await nativeRequest("textDocument/completion", mapped, token);
  ensureStateCurrent(state);
  return wrapResolveResults("textDocument/completion", mapProtocolValue(result, "virtual-to-source", state), state);
});

client.onRequest("textDocument/definition", async (rawParams, token) => {
  await workspaceReady;
  const params = rawParams as JsonObject;
  const uri = documentUri(params);
  if (uri !== undefined) await waitForDocument(uri, token);
  const state = stateFor(params);
  if (state !== undefined && isObject(params.position)) {
    const definition = await state.service.definition(state.original, params.position as unknown as Position, token);
    ensureStateCurrent(state);
    if (definition !== undefined) return definition;
  }
  const mapped = mapProtocolValue(params, "source-to-virtual", state);
  const result = await nativeRequest("textDocument/definition", mapped, token);
  ensureStateCurrent(state);
  return mapProtocolValue(result, "virtual-to-source", state);
});

client.onRequest("textDocument/codeAction", async (rawParams, token) => {
  await workspaceReady;
  const params = rawParams as JsonObject;
  const uri = documentUri(params);
  if (uri !== undefined) await waitForDocument(uri, token);
  const state = stateFor(params);
  const context = isObject(params.context) ? params.context : undefined;
  const diagnostics = Array.isArray(context?.diagnostics) ? context.diagnostics : [];
  const typedActions =
    state === undefined || !negotiated("diagnostic-fixes")
      ? []
      : await state.service.codeActions(state.original, diagnostics, token);
  const mapped = mapProtocolValue(params, "source-to-virtual", state);
  const native = await nativeRequest("textDocument/codeAction", mapped, token);
  ensureStateCurrent(state);
  const nativeActions = Array.isArray(native)
    ? (wrapResolveResults(
        "textDocument/codeAction",
        mapProtocolValue(native, "virtual-to-source", state),
        state,
      ) as readonly unknown[])
    : [];
  return [...typedActions, ...nativeActions];
});

client.onRequest(TYPED_SQL_STATUS_REQUEST, async (): Promise<TypedSqlLanguageServerStatus> => {
  if (!negotiated("status")) throw new ResponseError(-32601, "typedSql/status was not negotiated by this client");
  await workspaceReady;
  await previewReady;
  return {
    name: "@typed-sql/language-server",
    mode: "pinned-preview-proxy",
    typescriptVersion: TYPESCRIPT_PREVIEW_VERSION,
    workspaceRoots,
    openDocuments: sourceDocuments.size,
    indexedDocuments: virtualDocuments.size,
    protocol: negotiatedProtocol,
    workspaces: workspaceRoots.map((root) => ({ root, metrics: services.get(root)!.metrics() })),
  };
});

client.onRequest(async (method, rawParams, token) => {
  try {
    await workspaceReady;
  } catch (error) {
    if (method === "textDocument/diagnostic") return { kind: "full", items: [projectFailureDiagnostic(error)] };
    throw error;
  }
  const restored = method.endsWith("/resolve") ? resolveContexts.restore(rawParams, method) : { item: rawParams };
  if (restored.expired === true)
    throw new ResponseError(LSP_CONTENT_MODIFIED, "Resolve context expired; request fresh items");
  const params = restored.item;
  const uri = restored.context?.uri ?? documentUri(params);
  if (uri !== undefined) await waitForDocument(uri, token);
  // Failed schema analysis must remain visible to pull clients as a diagnostic,
  // not disappear when their pull report supersedes a pushed failure report.
  const projectFailure = uri === undefined ? undefined : projectFailureReports.get(uri);
  if (method === "textDocument/diagnostic" && projectFailure !== undefined)
    return { kind: "full", items: [projectFailure] };
  const state = restored.context?.state ?? (isObject(params) ? stateFor(params) : undefined);
  ensureStateCurrent(state);
  if (
    method === "textDocument/semanticTokens/full" ||
    method === "textDocument/semanticTokens/full/delta" ||
    method === "textDocument/semanticTokens/range"
  ) {
    return semanticTokens(method, params, state, token);
  }
  const mappedParams = mapProtocolValue(params, "source-to-virtual", state);
  const result = await nativeRequest(method, mappedParams, token);
  ensureStateCurrent(state);
  let mappedResult = mapProtocolValue(result, "virtual-to-source", state);
  if (restored.context !== undefined && isObject(mappedResult)) {
    mappedResult = resolveContexts.wrap([mappedResult], method, restored.context.uri, state!)[0];
  } else mappedResult = wrapResolveResults(method, mappedResult, state);
  if (method !== "textDocument/diagnostic" || state === undefined || !isObject(mappedResult)) {
    return mappedResult;
  }
  const items = Array.isArray(mappedResult.items) ? mappedResult.items : [];
  const typedDiagnostics = await state.service.diagnostics(state.original);
  ensureStateCurrent(state);
  return {
    ...mappedResult,
    items: protocolDiagnostics([...items, ...typedDiagnostics]),
  };
});

async function semanticTokens(
  method: string,
  params: unknown,
  state: DocumentState | undefined,
  token: CancellationToken,
): Promise<unknown> {
  const mapped = mapProtocolValue(params, "source-to-virtual", state);
  if (!isObject(mapped)) throw new ResponseError(-32602, "Expected semantic token parameters");
  // Request complete upstream data: delta indices refer to virtual arrays and
  // cannot be applied to the independently projected client array. Buffer partial
  // results by omitting the optional token, avoiding unprojected progress chunks.
  const { previousResultId: _previous, partialResultToken: _partial, ...request } = mapped;
  const result = await nativeRequest(
    method.endsWith("/delta") ? "textDocument/semanticTokens/full" : method,
    request,
    token,
  );
  ensureStateCurrent(state);
  const uri = documentUri(params);
  if (result === null) {
    if (uri !== undefined) semanticTokenResults.delete(uri);
    return null;
  }
  if (!isObject(result)) throw new TypeError("Invalid upstream semantic token response");
  const data = projectSemanticTokens(result.data, (item) => {
    if (state?.analysis === undefined) return item;
    const start = state.transformed.offsetAt(item);
    const sourceStart = virtualOffsetToSource(state, start);
    const sourceEnd = virtualOffsetToSource(state, start + item.length);
    return { ...state.original.positionAt(sourceStart), length: sourceEnd - sourceStart };
  });
  if (method.endsWith("/range") || uri === undefined) return { data };
  return semanticTokenResults.response(
    uri,
    data,
    method.endsWith("/delta") && isObject(params) && typeof params.previousResultId === "string"
      ? params.previousResultId
      : undefined,
  );
}

client.onNotification("textDocument/didOpen", (rawParams) => {
  const params = rawParams as DidOpenParams;
  const item = params.textDocument;
  const original = TextDocument.create(item.uri, item.languageId, item.version, item.text);
  sourceDocuments.set(item.uri, original);
  latestDocumentVersions.set(item.uri, item.version);
  const cancellation = beginDocumentAnalysis(item.uri, false);
  return queueDocument(item.uri, async () => {
    await workspaceReady;
    const virtual = virtualDocuments.get(item.uri);
    const state = await createState(original, virtual, cancellation);
    virtualDocuments.delete(item.uri);
    documents.set(item.uri, state);
    await typescript.sendNotification(
      virtual === undefined ? "textDocument/didOpen" : "textDocument/didChange",
      virtual === undefined
        ? { textDocument: { ...item, version: state.virtualVersion, text: state.transformed.getText() } }
        : {
            textDocument: { uri: item.uri, version: state.virtualVersion },
            contentChanges: [{ text: state.transformed.getText() }],
          },
    );
    await publishCombinedDiagnostics(state);
  });
});

client.onNotification("textDocument/didChange", (rawParams) => {
  const params = rawParams as DidChangeParams;
  const source = sourceDocuments.get(params.textDocument.uri);
  const original =
    source === undefined
      ? undefined
      : TextDocument.update(source, [...params.contentChanges], params.textDocument.version);
  if (original !== undefined) sourceDocuments.set(original.uri, original);
  latestDocumentVersions.set(params.textDocument.uri, params.textDocument.version);
  const cancellation = beginDocumentAnalysis(params.textDocument.uri, source !== undefined);
  return queueDocument(params.textDocument.uri, async () => {
    await workspaceReady;
    await serviceForUri(params.textDocument.uri).debounce(cancellation);
    const previous = documents.get(params.textDocument.uri);
    if (original === undefined) {
      await typescript.sendNotification("textDocument/didChange", params);
      return;
    }
    serviceForUri(original.uri).forget(original.uri);
    const state = await createState(original, previous, cancellation);
    documents.set(original.uri, state);
    await typescript.sendNotification("textDocument/didChange", {
      textDocument: { uri: original.uri, version: state.virtualVersion },
      contentChanges: [{ text: state.transformed.getText() }],
    });
    await publishCombinedDiagnostics(state);
  });
});

client.onNotification("textDocument/didClose", (rawParams) => {
  const params = rawParams as DidCloseParams;
  projectFailureReports.delete(params.textDocument.uri);
  semanticTokenResults.delete(params.textDocument.uri);
  resolveContexts.delete(params.textDocument.uri);
  sourceDocuments.delete(params.textDocument.uri);
  latestDocumentVersions.delete(params.textDocument.uri);
  documentAnalysisTokens.get(params.textDocument.uri)?.cancel();
  documentAnalysisTokens.delete(params.textDocument.uri);
  return queueDocument(params.textDocument.uri, async () => {
    await workspaceReady;
    const previous = documents.get(params.textDocument.uri);
    documents.delete(params.textDocument.uri);
    nativeDiagnostics.delete(params.textDocument.uri);
    serviceForUri(params.textDocument.uri).forget(params.textDocument.uri);
    try {
      const fileName = fileURLToPath(params.textDocument.uri);
      const text = await readFile(fileName, "utf8");
      const original = TextDocument.create(
        params.textDocument.uri,
        previous?.original.languageId ?? "typescript",
        0,
        text,
      );
      const state = await createState(original, previous);
      if (state.analysis !== undefined && state.analysis.queries.length > 0) {
        virtualDocuments.set(params.textDocument.uri, state);
        await typescript.sendNotification("textDocument/didChange", {
          textDocument: { uri: params.textDocument.uri, version: state.virtualVersion },
          contentChanges: [{ text: state.transformed.getText() }],
        });
      } else await typescript.sendNotification("textDocument/didClose", params);
    } catch {
      virtualDocuments.delete(params.textDocument.uri);
      await typescript.sendNotification("textDocument/didClose", params);
    }
    await client.sendNotification("textDocument/publishDiagnostics", {
      uri: params.textDocument.uri,
      diagnostics: [],
    });
  });
});

client.onNotification("workspace/didChangeConfiguration", (params) => {
  return queueWorkspace(async () => {
    const value = isObject(params) ? params.settings : undefined;
    const settings = settingsFrom(value);
    for (const [root, service] of services) service.configure(root, settings);
    await typescript.sendNotification("workspace/didChangeConfiguration", params);
    await refreshOpenDocuments();
    await resetVirtualDocuments();
  });
});

client.onNotification("workspace/didChangeWatchedFiles", (params) => {
  return queueWorkspace(async () => {
    const changes = watchedFileChanges(params);
    const nativeChanges =
      changes === undefined
        ? undefined
        : (
            await Promise.all(
              changes.map(async (change) =>
                (await serviceForUri(change.uri).handlesWatchedFile(change.uri)) ? undefined : change,
              ),
            )
          ).filter((change): change is WatchedFileChange => change !== undefined);
    const refresh =
      changes === undefined ||
      nativeChanges!.length !== changes.length ||
      changes.some(({ uri }) => /\/tsconfig[^/]*\.json$/u.test(uri));
    if (refresh) for (const service of services.values()) service.invalidate();
    if (nativeChanges === undefined || nativeChanges.length > 0) {
      await typescript.sendNotification(
        "workspace/didChangeWatchedFiles",
        nativeChanges === undefined ? params : { ...(isObject(params) ? params : {}), changes: nativeChanges },
      );
    }
    if (refresh) {
      await refreshOpenDocuments();
      await resetVirtualDocuments();
    }
  });
});

client.onNotification("exit", async () => {
  stopping = true;
  await typescript.sendNotification("exit");
  typescript.dispose();
  client.dispose();
  if (preview.exitCode === null) preview.kill();
});

client.onNotification(async (method, params) => {
  const state = isObject(params) ? stateFor(params) : undefined;
  await typescript.sendNotification(method, mapProtocolValue(params, "source-to-virtual", state));
});

typescript.onRequest(async (method, params) => {
  const state = isObject(params) ? stateFor(params) : undefined;
  const result = await client.sendRequest<unknown>(method, mapProtocolValue(params, "virtual-to-source", state));
  return mapProtocolValue(result, "source-to-virtual", state);
});

typescript.onNotification("textDocument/publishDiagnostics", async (params) => {
  if (!isObject(params) || typeof params.uri !== "string") {
    await client.sendNotification("textDocument/publishDiagnostics", params);
    return;
  }
  const state = documents.get(params.uri);
  if (virtualDocuments.has(params.uri)) return;
  if (state === undefined) {
    await client.sendNotification("textDocument/publishDiagnostics", params);
    return;
  }
  if (latestDocumentVersions.get(params.uri) !== state.original.version) return;
  if (typeof params.version === "number" && params.version !== state.virtualVersion) return;
  if (state.analysis !== undefined && !state.service.isAnalysisCurrent(state.original, state.analysis)) return;
  const mapped = mapProtocolValue(params, "virtual-to-source", state);
  const diagnostics = isObject(mapped) && Array.isArray(mapped.diagnostics) ? mapped.diagnostics : [];
  nativeDiagnostics.set(params.uri, diagnostics);
  await publishCombinedDiagnostics(state);
});

typescript.onNotification(async (method, params) => {
  const state = isObject(params) ? stateFor(params) : undefined;
  await client.sendNotification(method, mapProtocolValue(params, "virtual-to-source", state));
});

preview.on("exit", (code, signal) => {
  if (stopping && (code === 0 || code === null)) return;
  failPreview(previewError(`process exited with code ${code ?? "null"}${signal === null ? "" : ` (${signal})`}`));
});

typescript.listen();
client.listen();
