import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

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
    statusBar.text = `$(database) typed-sql: ${clients.size}/${folders}`;
    statusBar.tooltip = `${clients.size} typed-sql language server${clients.size === 1 ? "" : "s"} running`;
  }
  statusBar.show();
}

async function startClient(folder: vscode.WorkspaceFolder): Promise<void> {
  const key = folder.uri.toString();
  if (clients.has(key)) return;
  const server = serverPath(folder);
  if (server === undefined) {
    const message = `${folder.name}: install @typed-sql/language-server in the workspace or configure typedSql.serverPath.`;
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

async function stopClient(folder: vscode.WorkspaceFolder): Promise<void> {
  const key = folder.uri.toString();
  failures.delete(key);
  const running = clients.get(key);
  clients.delete(key);
  if (running !== undefined) {
    running.watcher.dispose();
    await running.client.stop();
  }
  refreshStatusBar();
}

async function restartClients(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  await Promise.all(folders.map(stopClient));
  await Promise.all(folders.map(startClient));
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
    vscode.workspace.onDidChangeWorkspaceFolders(async ({ added, removed }) => {
      await Promise.all(removed.map(stopClient));
      await Promise.all(added.map(startClient));
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("typedSql")) await restartClients();
    }),
  );
  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(startClient));
  refreshStatusBar();
}

export async function deactivate(): Promise<void> {
  await Promise.all(
    [...clients.values()].map(async ({ client, watcher }) => {
      watcher.dispose();
      await client.stop();
    }),
  );
  clients.clear();
}
