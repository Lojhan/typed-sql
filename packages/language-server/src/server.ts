#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cwd, stderr, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
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
const nativeDiagnostics = new Map<string, readonly unknown[]>();
const pendingDocuments = new Map<string, Promise<void>>();
let workspaceRoot = cwd();
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
  return uri === undefined ? fallback : documents.get(uri) ?? fallback;
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

client.onRequest("initialize", async (rawParams) => {
  const params = rawParams as InitializeParams;
  workspaceRoot = rootDirectory(params);
  service.configure(workspaceRoot, settingsFrom(params.initializationOptions));
  const result = await typescript.sendRequest<JsonObject>("initialize", params);
  return {
    ...result,
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

client.onRequest(async (method, params) => {
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
    const state = await createState(original);
    documents.set(item.uri, state);
    await typescript.sendNotification("textDocument/didOpen", {
      textDocument: {
        ...item,
        version: state.virtualVersion,
        text: state.transformed.getText(),
      },
    });
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
    documents.delete(params.textDocument.uri);
    nativeDiagnostics.delete(params.textDocument.uri);
    service.forget(params.textDocument.uri);
    await typescript.sendNotification("textDocument/didClose", params);
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
});

client.onNotification("workspace/didChangeWatchedFiles", async (params) => {
  service.invalidate();
  await typescript.sendNotification("workspace/didChangeWatchedFiles", params);
  await refreshOpenDocuments();
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
