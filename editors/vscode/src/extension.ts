import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { LifecycleQueue } from "./lifecycle.js";

interface TypedSqlServerStatus {
  readonly name: string;
  readonly mode: "pinned-preview-proxy";
  readonly typescriptVersion: string;
  readonly workspaceRoots: readonly string[];
  readonly openDocuments: number;
  readonly indexedDocuments: number;
  readonly protocol: { readonly version: number; readonly capabilities: readonly string[] };
  readonly workspaces: readonly { readonly metrics: { readonly bridgeRestarts: number } }[];
}

interface NativeClientAPI {
  readonly onLanguageServerInitialized: (listener: () => void) => vscode.Disposable;
}

function waitForNativeInitialization(api: NativeClientAPI): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let registration: vscode.Disposable | undefined;
    const timeout = setTimeout(() => {
      registration?.dispose();
      rejectReady(
        new Error(
          "The native TypeScript client did not initialize the selected SDK; check its TypeScript 7 output channel.",
        ),
      );
    }, 20_000);
    try {
      registration = api.onLanguageServerInitialized(() => {
        clearTimeout(timeout);
        queueMicrotask(() => registration?.dispose());
        resolveReady();
      });
    } catch (error) {
      clearTimeout(timeout);
      rejectReady(error);
    }
  });
}

interface RunningClient {
  readonly client: LanguageClient;
  readonly watcher: vscode.FileSystemWatcher;
  readonly server: string;
}

const SERVER_RELATIVE_PATH = join(
  "node_modules",
  "@typed-sql",
  "language-server",
  "dist",
  "packages",
  "language-server",
  "src",
  "server.js",
);
const DEVELOPMENT_SERVER_RELATIVE_PATH = join(
  "packages",
  "language-server",
  "dist",
  "packages",
  "language-server",
  "src",
  "server.js",
);
const TYPED_SQL_PROTOCOL_VERSION = 1;
const TYPED_SQL_PROTOCOL_CAPABILITIES = ["analysis-identity", "diagnostic-fixes", "status"] as const;
const clients = new Map<string, RunningClient>();
const nativeFolders = new Map<string, string>();
const lifecycle = new LifecycleQueue();
const failures = new Map<string, string>();
const output = vscode.window.createOutputChannel("typed-sql", { log: true });
let statusBar: vscode.StatusBarItem;

function optionalSetting(settings: vscode.WorkspaceConfiguration, name: string): string | undefined {
  const value = settings.get<string>(name, "").trim();
  return value.length === 0 ? undefined : value;
}

function initializationOptions(folder: vscode.WorkspaceFolder): Record<string, unknown> {
  const settings = vscode.workspace.getConfiguration("typedSql", folder.uri);
  const configPath = optionalSetting(settings, "configPath");
  const schemaPath = optionalSetting(settings, "schemaPath");
  const projectFile = optionalSetting(settings, "projectFile");
  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(schemaPath === undefined ? {} : { schemaPath }),
    ...(projectFile === undefined ? {} : { projectFile }),
    nativePreview: settings.get<boolean>("nativePreview", true),
    maxCacheEntries: settings.get<number>("maxCacheEntries", 256),
    maxWorkspaceFiles: settings.get<number>("maxWorkspaceFiles", 2_000),
    analysisDebounceMs: settings.get<number>("analysisDebounceMs", 20),
    protocolVersion: TYPED_SQL_PROTOCOL_VERSION,
    protocolCapabilities: [...TYPED_SQL_PROTOCOL_CAPABILITIES],
  };
}

function serverPath(folder: vscode.WorkspaceFolder): string | undefined {
  const configured = optionalSetting(vscode.workspace.getConfiguration("typedSql", folder.uri), "serverPath");
  if (configured !== undefined) {
    const candidate = isAbsolute(configured) ? configured : resolve(folder.uri.fsPath, configured);
    return existsSync(candidate) ? candidate : undefined;
  }
  for (const candidate of [
    join(folder.uri.fsPath, SERVER_RELATIVE_PATH),
    join(folder.uri.fsPath, DEVELOPMENT_SERVER_RELATIVE_PATH),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function serverOptions(server: string, folder: vscode.WorkspaceFolder): ServerOptions {
  const options = { cwd: folder.uri.fsPath };
  return {
    run: { module: server, transport: TransportKind.stdio, options },
    debug: { module: server, transport: TransportKind.stdio, options },
  };
}

function clientOptions(folder: vscode.WorkspaceFolder, watcher: vscode.FileSystemWatcher): LanguageClientOptions {
  const workspacePattern = { baseUri: folder.uri.toString(), pattern: "**/*" } as const;
  return {
    documentSelector: [
      { language: "typescript", scheme: "file", pattern: workspacePattern },
      { language: "typescriptreact", scheme: "file", pattern: workspacePattern },
    ],
    workspaceFolder: folder,
    initializationOptions: initializationOptions(folder),
    synchronize: { configurationSection: "typedSql", fileEvents: watcher },
    outputChannel: output,
  };
}

function refreshStatusBar(): void {
  const folders = vscode.workspace.workspaceFolders?.length ?? 0;
  if (folders === 0) {
    statusBar.text = "$(database) typed-sql: no workspace";
    statusBar.tooltip = "Open a workspace containing typed-sql.config.ts.";
  } else if (failures.size > 0) {
    statusBar.text = "$(warning) typed-sql";
    statusBar.tooltip = [...failures.values()].join("\n");
  } else {
    statusBar.text = `$(database) typed-sql: ${clients.size + nativeFolders.size}/${folders}`;
    statusBar.tooltip = `${clients.size} standalone server(s); ${nativeFolders.size} workspace(s) use Microsoft's native TypeScript client`;
  }
  statusBar.show();
}

function selectedNativeSdk(folder: vscode.WorkspaceFolder, server: string): string | undefined {
  const setting = vscode.workspace.getConfiguration("js/ts", folder.uri).get<string>("tsdk.path");
  if (typeof setting !== "string" || setting.length === 0) return undefined;
  const base =
    vscode.workspace.workspaceFile?.scheme === "file"
      ? dirname(vscode.workspace.workspaceFile.fsPath)
      : folder.uri.fsPath;
  const selected = resolve(base, setting);
  const expected = resolve(dirname(server), "../../../..", "sdk", `${process.platform}-${process.arch}`);
  if (!existsSync(selected) || !existsSync(expected)) return undefined;
  return realpathSync(selected) === realpathSync(expected) ? selected : undefined;
}

async function startClient(folder: vscode.WorkspaceFolder): Promise<void> {
  const key = folder.uri.toString();
  if (clients.has(key) || nativeFolders.has(key)) return;
  const server = serverPath(folder);
  if (server === undefined) {
    const message = `${folder.name}: install @typed-sql/language-server in the workspace or configure typedSql.serverPath.`;
    failures.set(key, message);
    output.appendLine(message);
    refreshStatusBar();
    return;
  }
  const mode = vscode.workspace.getConfiguration("typedSql", folder.uri).get<string>("providerMode", "auto");
  const sdk = selectedNativeSdk(folder, server);
  const nativeEnabled =
    vscode.workspace.getConfiguration("js/ts", folder.uri).get<boolean>("experimental.useTsgo") ??
    vscode.workspace.getConfiguration("typescript", folder.uri).get<boolean>("experimental.useTsgo", false);
  const native = vscode.extensions.getExtension<NativeClientAPI | undefined>("TypeScriptTeam.native-preview");
  if (mode !== "proxy" && sdk !== undefined && nativeEnabled && native !== undefined) {
    try {
      const api = await native.activate();
      if (api === undefined || typeof api.onLanguageServerInitialized !== "function")
        throw new Error("Microsoft's TypeScript client does not expose its initialization event.");
      await waitForNativeInitialization(api);
      nativeFolders.set(key, sdk);
      failures.delete(key);
      output.appendLine(`${folder.name}: Microsoft's TypeScript client owns providers through typed-sql SDK ${sdk}`);
    } catch (error) {
      failures.set(key, `${folder.name}: cannot activate Microsoft's TypeScript client: ${String(error)}`);
    }
    refreshStatusBar();
    return;
  }
  if (mode === "native-sdk" || vscode.extensions.getExtension("vscode.typescript-language-features") !== undefined) {
    const message = `${folder.name}: configure Microsoft's TypeScript 7 extension with the typed-sql editor SDK and enable js/ts.experimental.useTsgo. The standalone proxy requires the competing built-in provider to be disabled explicitly.`;
    failures.set(key, message);
    output.appendLine(message);
    refreshStatusBar();
    return;
  }
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, "**/{typed-sql.config.*,schema.json,*.ts,*.mts,*.cts,*.js,*.mjs,*.cjs,*.json}"),
  );
  const client = new LanguageClient(
    `typed-sql-${folder.index}`,
    `typed-sql (${folder.name})`,
    serverOptions(server, folder),
    clientOptions(folder, watcher),
  );
  try {
    await client.start();
    failures.delete(key);
    clients.set(key, { client, watcher, server });
    output.appendLine(`${folder.name}: started ${server}`);
  } catch (error) {
    watcher.dispose();
    const message = `${folder.name}: ${error instanceof Error ? error.message : String(error)}`;
    failures.set(key, message);
    output.appendLine(`Could not start typed-sql: ${message}`);
  }
  refreshStatusBar();
}

async function stopClient(key: string): Promise<void> {
  failures.delete(key);
  nativeFolders.delete(key);
  const running = clients.get(key);
  clients.delete(key);
  if (running !== undefined) {
    running.watcher.dispose();
    await running.client.stop();
  }
  refreshStatusBar();
}

async function restartClients(): Promise<void> {
  await Promise.all([...new Set([...clients.keys(), ...nativeFolders.keys()])].map(stopClient));
  await synchronizeClients();
}

async function synchronizeClients(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const current = new Set(folders.map((folder) => folder.uri.toString()));
  await Promise.all(
    [...new Set([...clients.keys(), ...nativeFolders.keys()])].filter((key) => !current.has(key)).map(stopClient),
  );
  for (const key of failures.keys()) if (!current.has(key)) failures.delete(key);
  await Promise.all(folders.map(startClient));
  refreshStatusBar();
}

function scheduleLifecycle(operation: () => Promise<void>): Promise<void> {
  return lifecycle.run(operation).catch((error: unknown) => {
    output.appendLine(`typed-sql lifecycle failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function showStatus(): Promise<void> {
  const reports = await Promise.all(
    [...clients.entries()].map(async ([key, running]) => {
      try {
        const status = await running.client.sendRequest<TypedSqlServerStatus>("typedSql/status");
        const folderName = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(key))?.name ?? key;
        return `${folderName}: ${status.mode}, TypeScript ${status.typescriptVersion}, protocol ${status.protocol.version}; ${status.openDocuments} open, ${status.indexedDocuments} indexed (${running.server})`;
      } catch (error) {
        return `${key}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
  );
  for (const [key, sdk] of nativeFolders) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(key));
    reports.push(
      `${folder?.name ?? key}: native-sdk; Microsoft's TypeScript client owns language features; SDK ${sdk}. Open the TypeScript 7 output channel for server logs.`,
    );
  }
  reports.push(...failures.values());
  const message = reports.length === 0 ? "No typed-sql language server is running." : reports.join("\n");
  output.appendLine(message);
  const selection = await vscode.window.showInformationMessage(message, "Show output");
  if (selection === "Show output") output.show();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = "typedSql.showBridgeStatus";
  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand("typedSql.showBridgeStatus", showStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleLifecycle(synchronizeClients)),
    vscode.extensions.onDidChange(() => scheduleLifecycle(restartClients)),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (
        event.affectsConfiguration("typedSql") ||
        event.affectsConfiguration("js/ts") ||
        event.affectsConfiguration("typescript")
      )
        await scheduleLifecycle(restartClients);
    }),
  );
  await scheduleLifecycle(synchronizeClients);
  refreshStatusBar();
}

export async function deactivate(): Promise<void> {
  await lifecycle.close(async () => {
    await Promise.all([...new Set([...clients.keys(), ...nativeFolders.keys()])].map(stopClient));
  });
}
