#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cwd, stderr, stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BridgeAnalysis } from "@typed-sql/ts-bridge";
import { typescriptPreviewCliPath } from "@typed-sql/ts-bridge/native-lsp";
import { TYPESCRIPT_PREVIEW_VERSION } from "@typed-sql/ts-bridge/native-preview";
import {
  createMessageConnection,
  type MessageConnection,
  NullLogger,
} from "vscode-jsonrpc/node";
import {
  TextDocument,
  type TextDocumentContentChangeEvent,
} from "vscode-languageserver-textdocument";
import { settingsFrom, TypedSqlLanguageService } from "./index.js";

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
  readonly virtualVersion: number;
}

type JsonObject = Record<string, unknown>;
type MappingDirection = "source-to-virtual" | "virtual-to-source";

const preview = spawn(process.execPath, [typescriptPreviewCliPath(), "--lsp", "--stdio"], {
  cwd: cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});
const client = createMessageConnection(stdin, stdout, NullLogger);
const typescript: MessageConnection = createMessageConnection(preview.stdout, preview.stdin, NullLogger);
const documents = new Map<string, DocumentState>();
const virtualDocuments = new Map<string, DocumentState>();
const nativeDiagnostics = new Map<string, readonly unknown[]>();
const pendingDocuments = new Map<string, Promise<void>>();
let workspaceRoot = cwd();
let workspaceReady: Promise<void> = Promise.resolve();
const service = new TypedSqlLanguageService(workspaceRoot);

preview.stderr.on("data", (chunk: Buffer | string) => {
  stderr.write(`[typed-sql/typescript-${TYPESCRIPT_PREVIEW_VERSION}] ${chunk.toString()}`);
});

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rootDirectory(params: InitializeParams): string {
  const uri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  return typeof uri === "string" && uri.startsWith("file:") ? fileURLToPath(uri) : cwd();
}

function sourceOffsetToVirtual(state: DocumentState, offset: number): number {
  if (state.analysis === undefined) return offset;
  return offset + state.analysis.insertions.reduce(
    (shift, insertion) => shift + (insertion.position < offset ? insertion.length : 0),
    0,
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
  const uri = typeof value.uri === "string"
    ? value.uri
    : isObject(value.textDocument) && typeof value.textDocument.uri === "string"
      ? value.textDocument.uri
      : undefined;
  return uri === undefined ? fallback : documents.get(uri) ?? virtualDocuments.get(uri) ?? fallback;
}

function documentUri(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.uri === "string") return value.uri;
  return isObject(value.textDocument) && typeof value.textDocument.uri === "string"
    ? value.textDocument.uri
    : undefined;
}

function queueDocument(uri: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingDocuments.get(uri) ?? Promise.resolve();
  const pending = previous.then(operation);
  pendingDocuments.set(uri, pending);
  return pending.finally(() => {
    if (pendingDocuments.get(uri) === pending) pendingDocuments.delete(uri);
  });
}

function mapProtocolValue(
  value: unknown,
  direction: MappingDirection,
  fallback?: DocumentState,
): unknown {
  if (Array.isArray(value)) return value.map((item) => mapProtocolValue(item, direction, fallback));
  if (!isObject(value)) return value;
  const state = stateFor(value, fallback);
  if (state !== undefined && typeof value.line === "number" && typeof value.character === "number") {
    return mapPosition(state, value as unknown as Position, direction);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    mapProtocolValue(item, direction, state),
  ]));
}

async function createState(
  original: TextDocument,
  previous?: DocumentState,
): Promise<DocumentState> {
  const analysis = await service.analysis(original);
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
    virtualVersion,
  };
}

async function combinedDiagnostics(state: DocumentState): Promise<readonly unknown[]> {
  return [
    ...(nativeDiagnostics.get(state.original.uri) ?? []),
    ...await service.diagnostics(state.original),
  ];
}

async function publishCombinedDiagnostics(state: DocumentState): Promise<void> {
  await client.sendNotification("textDocument/publishDiagnostics", {
    uri: state.original.uri,
    version: state.original.version,
    diagnostics: await combinedDiagnostics(state),
  });
}

async function refreshOpenDocuments(): Promise<void> {
  for (const [uri, previous] of documents) {
    service.forget(uri);
    const state = await createState(previous.original, previous);
    documents.set(uri, state);
    await typescript.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: state.virtualVersion },
      contentChanges: [{ text: state.transformed.getText() }],
    });
    await publishCombinedDiagnostics(state);
  }
}

async function preloadWorkspaceDocuments(): Promise<void> {
  for (const fileName of await service.workspaceFiles()) {
    const uri = pathToFileURL(fileName).href;
    if (documents.has(uri) || virtualDocuments.has(uri)) continue;
    const text = await readFile(fileName, "utf8");
    const original = TextDocument.create(uri, /\.tsx$/u.test(fileName) ? "typescriptreact" : "typescript", 0, text);
    const state = await createState(original);
    if (state.analysis?.queries.length === 0 || state.analysis === undefined) continue;
    virtualDocuments.set(uri, state);
    await typescript.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: original.languageId, version: state.virtualVersion, text: state.transformed.getText() },
    });
  }
}

async function resetVirtualDocuments(): Promise<void> {
  for (const uri of virtualDocuments.keys()) {
    await typescript.sendNotification("textDocument/didClose", { textDocument: { uri } });
    service.forget(uri);
  }
  virtualDocuments.clear();
  await preloadWorkspaceDocuments();
}

client.onRequest("initialize", async (rawParams) => {
  const params = rawParams as InitializeParams;
  workspaceRoot = rootDirectory(params);
  service.configure(workspaceRoot, settingsFrom(params.initializationOptions));
  const result = await typescript.sendRequest<JsonObject>("initialize", params);
  return {
    ...result,
    capabilities: {
      ...(isObject(result.capabilities) ? result.capabilities : {}),
      completionProvider: { triggerCharacters: ["."] },
      definitionProvider: true,
      codeActionProvider: true,
    },
    serverInfo: {
      name: "typed-sql + TypeScript preview",
      version: TYPESCRIPT_PREVIEW_VERSION,
    },
  };
});

client.onRequest("shutdown", async () => {
  const result = await typescript.sendRequest("shutdown");
  await service.close();
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
  if (uri !== undefined) await pendingDocuments.get(uri);
  const state = stateFor(params);
  if (state !== undefined && isObject(params.position)) {
    const items = await service.completions(state.original, params.position as unknown as Position, token);
    if (items.length > 0) return { isIncomplete: false, items };
  }
  const mapped = mapProtocolValue(params, "source-to-virtual", state);
  return mapProtocolValue(await typescript.sendRequest("textDocument/completion", mapped), "virtual-to-source", state);
});

client.onRequest("textDocument/definition", async (rawParams, token) => {
  await workspaceReady;
  const params = rawParams as JsonObject;
  const uri = documentUri(params);
  if (uri !== undefined) await pendingDocuments.get(uri);
  const state = stateFor(params);
  if (state !== undefined && isObject(params.position)) {
    const definition = await service.definition(state.original, params.position as unknown as Position, token);
    if (definition !== undefined) return definition;
  }
  const mapped = mapProtocolValue(params, "source-to-virtual", state);
  return mapProtocolValue(await typescript.sendRequest("textDocument/definition", mapped), "virtual-to-source", state);
});

client.onRequest("textDocument/codeAction", async (rawParams, token) => {
  await workspaceReady;
  const params = rawParams as JsonObject;
  const uri = documentUri(params);
  if (uri !== undefined) await pendingDocuments.get(uri);
  const state = stateFor(params);
  const context = isObject(params.context) ? params.context : undefined;
  const diagnostics = Array.isArray(context?.diagnostics) ? context.diagnostics : [];
  const typedActions = state === undefined ? [] : await service.codeActions(state.original, diagnostics, token);
  const mapped = mapProtocolValue(params, "source-to-virtual", state);
  const native = await typescript.sendRequest<unknown>("textDocument/codeAction", mapped);
  const nativeActions = Array.isArray(native) ? mapProtocolValue(native, "virtual-to-source", state) as readonly unknown[] : [];
  return [...typedActions, ...nativeActions];
});

client.onRequest(async (method, params) => {
  await workspaceReady;
  const uri = documentUri(params);
  if (uri !== undefined) await pendingDocuments.get(uri);
  const state = isObject(params) ? stateFor(params) : undefined;
  const mappedParams = mapProtocolValue(params, "source-to-virtual", state);
  const result = await typescript.sendRequest<unknown>(method, mappedParams);
  const mappedResult = mapProtocolValue(result, "virtual-to-source", state);
  if (method !== "textDocument/diagnostic" || state === undefined || !isObject(mappedResult)) {
    return mappedResult;
  }
  const items = Array.isArray(mappedResult.items) ? mappedResult.items : [];
  return {
    ...mappedResult,
    items: [...items, ...await service.diagnostics(state.original)],
  };
});

client.onNotification("textDocument/didOpen", (rawParams) => {
  const params = rawParams as DidOpenParams;
  const item = params.textDocument;
  return queueDocument(item.uri, async () => {
    const original = TextDocument.create(item.uri, item.languageId, item.version, item.text);
    const virtual = virtualDocuments.get(item.uri);
    const state = await createState(original, virtual);
    virtualDocuments.delete(item.uri);
    documents.set(item.uri, state);
    await typescript.sendNotification(virtual === undefined ? "textDocument/didOpen" : "textDocument/didChange", virtual === undefined
      ? { textDocument: { ...item, version: state.virtualVersion, text: state.transformed.getText() } }
      : { textDocument: { uri: item.uri, version: state.virtualVersion }, contentChanges: [{ text: state.transformed.getText() }] });
    await publishCombinedDiagnostics(state);
  });
});

client.onNotification("textDocument/didChange", (rawParams) => {
  const params = rawParams as DidChangeParams;
  return queueDocument(params.textDocument.uri, async () => {
    const previous = documents.get(params.textDocument.uri);
    if (previous === undefined) {
      await typescript.sendNotification("textDocument/didChange", params);
      return;
    }
    const original = TextDocument.update(
      previous.original,
      [...params.contentChanges],
      params.textDocument.version,
    );
    service.forget(original.uri);
    const state = await createState(original, previous);
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
  return queueDocument(params.textDocument.uri, async () => {
    const previous = documents.get(params.textDocument.uri);
    documents.delete(params.textDocument.uri);
    nativeDiagnostics.delete(params.textDocument.uri);
    service.forget(params.textDocument.uri);
    try {
      const fileName = fileURLToPath(params.textDocument.uri);
      const text = await readFile(fileName, "utf8");
      const original = TextDocument.create(params.textDocument.uri, previous?.original.languageId ?? "typescript", 0, text);
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

client.onNotification("workspace/didChangeConfiguration", async (params) => {
  const value = isObject(params) ? params.settings : undefined;
  service.configure(workspaceRoot, settingsFrom(value));
  await typescript.sendNotification("workspace/didChangeConfiguration", params);
  await refreshOpenDocuments();
  await resetVirtualDocuments();
});

client.onNotification("workspace/didChangeWatchedFiles", async (params) => {
  service.invalidate();
  await typescript.sendNotification("workspace/didChangeWatchedFiles", params);
  await refreshOpenDocuments();
  await resetVirtualDocuments();
});

client.onNotification("exit", async () => {
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
  const result = await client.sendRequest<unknown>(
    method,
    mapProtocolValue(params, "virtual-to-source", state),
  );
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
  if (code !== 0 && code !== null) {
    stderr.write(`typed-sql: TypeScript preview exited with code ${code}${signal === null ? "" : ` (${signal})`}\n`);
  }
});

typescript.listen();
client.listen();
