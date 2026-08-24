import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fromConfig, loadConfig } from "@typed-sql/config";
import type { SchemaSnapshot } from "@typed-sql/core";
import { loadSchemaSnapshot } from "@typed-sql/schema";
import {
  analyzeSource,
  queryAtPosition,
  type BridgeAnalysis,
  type NativeTypeInspection,
} from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";
import * as vscode from "vscode";

interface NativeTypeScriptExtensionAPI {
  readonly initializeAPIConnection: (pipe?: string) => Promise<string>;
}

interface CachedSchema {
  readonly modified: number;
  readonly snapshot: SchemaSnapshot;
}

interface DocumentAnalysis {
  readonly version: number;
  readonly schemaPath: string;
  readonly schemaModified: number;
  readonly analysis: BridgeAnalysis;
}

const languageSelector: vscode.DocumentSelector = [
  { language: "typescript", scheme: "file" },
  { language: "typescriptreact", scheme: "file" },
];

const schemaCache = new Map<string, CachedSchema>();
const analysisCache = new Map<string, DocumentAnalysis>();
const inspectionCache = new Map<string, readonly NativeTypeInspection[]>();
const output = vscode.window.createOutputChannel("typed-sql");
let diagnostics: vscode.DiagnosticCollection;
let nativeBridgePromise: Promise<NativePreviewTypeScriptBridge | undefined> | undefined;
let nativeBridgeStatus = "not connected";

function configuredPath(document: vscode.TextDocument, value: string): string | undefined {
  if (isAbsolute(value)) return value;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return folder === undefined ? undefined : resolve(folder.uri.fsPath, value);
}

async function schemaAt(path: string): Promise<CachedSchema> {
  const file = await stat(path);
  const cached = schemaCache.get(path);
  if (cached !== undefined && cached.modified === file.mtimeMs) return cached;
  const snapshot = await loadSchemaSnapshot(path);
  const result = { modified: file.mtimeMs, snapshot };
  schemaCache.set(path, result);
  return result;
}

async function documentAnalysis(document: vscode.TextDocument): Promise<DocumentAnalysis | undefined> {
  const key = document.uri.toString();
  try {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder === undefined) return undefined;
    const settings = vscode.workspace.getConfiguration("typedSql", document.uri);
    const configSetting = settings.get<string>("configPath", "").trim();
    const loaded = await loadConfig({
      cwd: folder.uri.fsPath,
      ...(configSetting.length === 0 ? {} : { file: configuredPath(document, configSetting)! }),
    });
    const schemaSetting = settings.get<string>("schemaPath", "").trim();
    const schemaPath = schemaSetting.length === 0
      ? fromConfig(loaded.directory, loaded.config.schema.file)
      : configuredPath(document, schemaSetting)!;
    const schema = await schemaAt(schemaPath);
    const cached = analysisCache.get(key);
    if (cached !== undefined
      && cached.version === document.version
      && cached.schemaPath === schemaPath
      && cached.schemaModified === schema.modified) return cached;
    const result = {
      version: document.version,
      schemaPath,
      schemaModified: schema.modified,
      analysis: analyzeSource(
        document.getText(),
        loaded.config.dialect.validateSnapshot(schema.snapshot),
        loaded.config.dialect,
        loaded.config.typePolicy ?? loaded.config.dialect.defaultTypePolicy,
      ),
    };
    analysisCache.set(key, result);
    return result;
  } catch (error) {
    output.appendLine(`Unable to analyze ${document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function diagnosticSeverity(severity: "error" | "info" | "warning"): vscode.DiagnosticSeverity {
  if (severity === "error") return vscode.DiagnosticSeverity.Error;
  return severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
}

async function refreshDiagnostics(document: vscode.TextDocument): Promise<void> {
  if (document.languageId !== "typescript" && document.languageId !== "typescriptreact") return;
  const startingVersion = document.version;
  const result = await documentAnalysis(document);
  if (document.version !== startingVersion) return;
  if (result === undefined) {
    diagnostics.delete(document.uri);
    return;
  }
  diagnostics.set(document.uri, result.analysis.diagnostics.map((item) => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(item.range.start), document.positionAt(item.range.end)),
      `${item.code}: ${item.message}`,
      diagnosticSeverity(item.severity),
    );
    diagnostic.source = "typed-sql";
    diagnostic.code = item.code;
    return diagnostic;
  }));
}

async function connectNativeBridge(): Promise<NativePreviewTypeScriptBridge | undefined> {
  if (!vscode.workspace.getConfiguration("typedSql").get<boolean>("nativePreview", true)) {
    nativeBridgeStatus = "disabled by typedSql.nativePreview";
    return undefined;
  }
  for (const extensionId of ["TypeScriptTeam.native-preview", "vscode.typescript-language-features"]) {
    const extension = vscode.extensions.getExtension<NativeTypeScriptExtensionAPI | undefined>(extensionId);
    if (extension === undefined) continue;
    try {
      const extensionApi = await extension.activate();
      if (extensionApi?.initializeAPIConnection === undefined) continue;
      const pipe = await extensionApi.initializeAPIConnection();
      const bridge = await NativePreviewTypeScriptBridge.connect(pipe);
      nativeBridgeStatus = `connected through ${extensionId}`;
      output.appendLine(`TypeScript 7 preview bridge ${nativeBridgeStatus}`);
      return bridge;
    } catch (error) {
      output.appendLine(`Could not connect through ${extensionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  nativeBridgeStatus = "resolver fallback (TypeScript 7 API connection unavailable)";
  return undefined;
}

function nativeBridge(): Promise<NativePreviewTypeScriptBridge | undefined> {
  nativeBridgePromise ??= connectNativeBridge();
  return nativeBridgePromise;
}

async function inspectWithNativeBridge(
  document: vscode.TextDocument,
  result: DocumentAnalysis,
): Promise<readonly NativeTypeInspection[] | undefined> {
  const key = `${document.uri.toString()}@${document.version}:${result.schemaPath}@${result.schemaModified}`;
  const cached = inspectionCache.get(key);
  if (cached !== undefined) return cached;
  const bridge = await nativeBridge();
  if (bridge === undefined) return undefined;
  try {
    const inspections = await bridge.inspectFile({ fileName: document.uri.fsPath, analysis: result.analysis });
    inspectionCache.set(key, inspections);
    return inspections;
  } catch (error) {
    nativeBridgeStatus = "resolver fallback (preview request failed)";
    output.appendLine(`TypeScript preview inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function provideHover(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Hover | undefined> {
  const result = await documentAnalysis(document);
  if (result === undefined) return undefined;
  const offset = document.offsetAt(position);
  const query = queryAtPosition(result.analysis, offset);
  if (query === undefined) return undefined;
  const nativeInspections = await inspectWithNativeBridge(document, result);
  const nativeType = nativeInspections?.find((inspection) => inspection.queryIndex === query.index)?.typeText;
  const typeText = nativeType ?? query.queryType;
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown("**typed-sql inferred query type**\n\n");
  markdown.appendCodeblock(typeText, "typescript");
  markdown.appendMarkdown(nativeType === undefined
    ? "\nResolver result; install/enable the TypeScript 7 extension for native snapshot verification."
    : "\nVerified through a temporary TypeScript 7.1 preview snapshot.");
  const range = query.binding !== undefined && offset >= query.binding.range.start && offset <= query.binding.range.end
    ? query.binding.range
    : query.sourceRange;
  return new vscode.Hover(markdown, new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)));
}

async function resetNativeBridge(): Promise<void> {
  const current = await nativeBridgePromise;
  nativeBridgePromise = undefined;
  nativeBridgeStatus = "not connected";
  inspectionCache.clear();
  await current?.close();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  diagnostics = vscode.languages.createDiagnosticCollection("typed-sql");
  context.subscriptions.push(
    diagnostics,
    output,
    vscode.languages.registerHoverProvider(languageSelector, { provideHover }),
    vscode.commands.registerCommand("typedSql.showBridgeStatus", async () => {
      await nativeBridge();
      await vscode.window.showInformationMessage(`typed-sql TypeScript bridge: ${nativeBridgeStatus}`);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => { void refreshDiagnostics(document); }),
    vscode.workspace.onDidSaveTextDocument((document) => { void refreshDiagnostics(document); }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      analysisCache.delete(document.uri.toString());
      void refreshDiagnostics(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      analysisCache.delete(document.uri.toString());
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("typedSql")) return;
      schemaCache.clear();
      analysisCache.clear();
      void resetNativeBridge();
      for (const document of vscode.workspace.textDocuments) void refreshDiagnostics(document);
    }),
    { dispose: () => { void resetNativeBridge(); } },
  );
  for (const document of vscode.workspace.textDocuments) void refreshDiagnostics(document);
}

export async function deactivate(): Promise<void> {
  await resetNativeBridge();
}
