import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromConfig, loadConfig } from "@typed-sql/config";
import type { SchemaSnapshot, TableSnapshot } from "@typed-sql/core";
import { loadSchemaSnapshot } from "@typed-sql/schema";
import { analyzeSource, type BridgeAnalysis, type NativeTypeInspection, queryAtPosition } from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";
import {
  type CodeAction,
  CodeActionKind,
  type CompletionItem,
  CompletionItemKind,
  type Definition,
  type Diagnostic,
  DiagnosticSeverity,
  type Hover,
  MarkupKind,
  type Position,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

export interface TypedSqlLanguageServerSettings {
  readonly configPath?: string;
  readonly schemaPath?: string;
  readonly projectFile?: string;
  readonly nativePreview?: boolean;
  readonly maxCacheEntries?: number;
  readonly maxWorkspaceFiles?: number;
}

interface CachedSchema {
  readonly modified: number;
  readonly snapshot: SchemaSnapshot;
}

interface DocumentAnalysis {
  readonly version: number;
  readonly schemaPath: string;
  readonly schemaModified: number;
  readonly snapshot: SchemaSnapshot;
  readonly projectFile?: string;
  readonly analysis: BridgeAnalysis;
}

const defaultSettings: Required<Pick<TypedSqlLanguageServerSettings, "schemaPath" | "nativePreview">> = {
  schemaPath: "src/generated/db/schema.json",
  nativePreview: true,
};
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const DEFAULT_MAX_SCHEMA_CACHE_ENTRIES = 16;
const DEFAULT_MAX_WORKSPACE_FILES = 2_000;

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

function cancelled(token?: CancellationLike): void {
  if (token?.isCancellationRequested === true) {
    const error = new Error("typed-sql request cancelled");
    error.name = "AbortError";
    throw error;
  }
}

function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V, maximum: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximum) cache.delete(cache.keys().next().value!);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findUp(filename: string, start: string): Promise<string | undefined> {
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, filename);
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function severity(value: "error" | "info" | "warning"): DiagnosticSeverity {
  if (value === "error") return DiagnosticSeverity.Error;
  return value === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information;
}

export function settingsFrom(value: unknown): TypedSqlLanguageServerSettings {
  if (typeof value !== "object" || value === null) return {};
  const object = value as Record<string, unknown>;
  const nested = object.typedSql ?? object["typed-sql"];
  const candidate = typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : object;
  return {
    ...(typeof candidate.schemaPath === "string" ? { schemaPath: candidate.schemaPath } : {}),
    ...(typeof candidate.configPath === "string" ? { configPath: candidate.configPath } : {}),
    ...(typeof candidate.projectFile === "string" ? { projectFile: candidate.projectFile } : {}),
    ...(typeof candidate.nativePreview === "boolean" ? { nativePreview: candidate.nativePreview } : {}),
    ...(typeof candidate.maxCacheEntries === "number" ? { maxCacheEntries: candidate.maxCacheEntries } : {}),
    ...(typeof candidate.maxWorkspaceFiles === "number" ? { maxWorkspaceFiles: candidate.maxWorkspaceFiles } : {}),
  };
}

export class TypedSqlLanguageService {
  #rootDirectory: string;
  #settings: TypedSqlLanguageServerSettings;
  readonly #schemaCache = new Map<string, CachedSchema>();
  readonly #analysisCache = new Map<string, DocumentAnalysis>();
  readonly #inspectionCache = new Map<string, Promise<readonly NativeTypeInspection[] | undefined>>();
  #nativeBridgePromise: Promise<NativePreviewTypeScriptBridge> | undefined;
  #configPromise: ReturnType<typeof loadConfig> | undefined;

  constructor(rootDirectory: string, settings: TypedSqlLanguageServerSettings = {}) {
    this.#rootDirectory = resolve(rootDirectory);
    this.#settings = this.#validatedSettings(settings);
  }

  configure(rootDirectory: string, settings: TypedSqlLanguageServerSettings): void {
    this.#rootDirectory = resolve(rootDirectory);
    this.#settings = this.#validatedSettings(settings);
    this.#schemaCache.clear();
    this.#analysisCache.clear();
    this.#inspectionCache.clear();
    this.#configPromise = undefined;
    this.#resetNativeBridge();
  }

  invalidate(): void {
    this.#schemaCache.clear();
    this.#analysisCache.clear();
    this.#inspectionCache.clear();
    this.#configPromise = undefined;
  }

  forget(uri: string): void {
    this.#analysisCache.delete(uri);
    for (const key of this.#inspectionCache.keys()) {
      if (key.startsWith(`${uri}@`)) this.#inspectionCache.delete(key);
    }
  }

  async diagnostics(document: TextDocument, token?: CancellationLike): Promise<readonly Diagnostic[]> {
    const result = await this.#documentAnalysis(document, token);
    if (result === undefined) return [];
    return result.analysis.diagnostics.map(
      (item): Diagnostic => ({
        range: {
          start: document.positionAt(item.range.start),
          end: document.positionAt(item.range.end),
        },
        message: `${item.code}: ${item.message}`,
        severity: severity(item.severity),
        source: "typed-sql",
        code: item.code,
        data: item.suggestion === undefined ? undefined : { suggestion: item.suggestion },
      }),
    );
  }

  async analysis(document: TextDocument, token?: CancellationLike): Promise<BridgeAnalysis | undefined> {
    return (await this.#documentAnalysis(document, token))?.analysis;
  }

  async hover(
    document: TextDocument,
    position: { readonly line: number; readonly character: number },
  ): Promise<Hover | undefined> {
    const result = await this.#documentAnalysis(document);
    if (result === undefined) return undefined;
    const offset = document.offsetAt(position);
    const query = queryAtPosition(result.analysis, offset);
    if (query === undefined) return undefined;
    const inspections = await this.#nativeInspections(document, result);
    const nativeType = inspections?.find((inspection) => inspection.queryIndex === query.index)?.typeText;
    const range =
      query.binding !== undefined && offset >= query.binding.range.start && offset <= query.binding.range.end
        ? query.binding.range
        : query.sourceRange;
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: [
          "**typed-sql inferred query type**",
          "",
          "```typescript",
          nativeType ?? query.queryType,
          "```",
          "",
          nativeType === undefined
            ? "Resolver result; native TypeScript 7 preview verification was unavailable."
            : "Verified through a temporary TypeScript 7.1 preview snapshot.",
        ].join("\n"),
      },
      range: {
        start: document.positionAt(range.start),
        end: document.positionAt(range.end),
      },
    };
  }

  async completions(
    document: TextDocument,
    position: Position,
    token?: CancellationLike,
  ): Promise<readonly CompletionItem[]> {
    const result = await this.#documentAnalysis(document, token);
    if (result === undefined) return [];
    const offset = document.offsetAt(position);
    const query = queryAtPosition(result.analysis, offset);
    if (query === undefined) return [];
    cancelled(token);
    const source = document.getText();
    const before = source.slice(query.sourceRange.start, offset);
    const qualifier = /([A-Za-z_$][A-Za-z0-9_$]*)\.[A-Za-z0-9_$]*$/u.exec(before)?.[1];
    const aliasTable =
      qualifier === undefined
        ? undefined
        : this.#tableForAlias(source.slice(query.sourceRange.start, query.sourceRange.end), qualifier, result.snapshot);
    const items: CompletionItem[] = [];
    const labels = new Set<string>();
    const add = (item: CompletionItem): void => {
      if (labels.has(item.label)) return;
      labels.add(item.label);
      items.push(item);
    };
    const tables = aliasTable === undefined ? Object.values(result.snapshot.tables) : [aliasTable];
    if (qualifier === undefined) {
      for (const table of tables)
        add({
          label: table.name,
          kind: CompletionItemKind.Class,
          detail: table.schema === undefined ? "table" : `table in ${table.schema}`,
        });
      for (const keyword of [
        "SELECT",
        "FROM",
        "WHERE",
        "JOIN",
        "GROUP BY",
        "ORDER BY",
        "INSERT",
        "UPDATE",
        "DELETE",
        "RETURNING",
      ]) {
        add({ label: keyword, kind: CompletionItemKind.Keyword });
      }
    }
    for (const table of tables) {
      for (const column of Object.values(table.columns)) {
        add({
          label: column.name,
          kind: CompletionItemKind.Field,
          detail: `${column.databaseType}${column.nullable ? " nullable" : " not null"} — ${column.tsType}`,
        });
      }
    }
    return items;
  }

  async definition(
    document: TextDocument,
    position: Position,
    token?: CancellationLike,
  ): Promise<Definition | undefined> {
    const result = await this.#documentAnalysis(document, token);
    if (result === undefined) return undefined;
    const offset = document.offsetAt(position);
    const query = queryAtPosition(result.analysis, offset);
    if (query === undefined) return undefined;
    const word = this.#wordAt(document.getText(), offset);
    if (word === undefined) return undefined;
    cancelled(token);
    const schemaSource = await readFile(result.schemaPath, "utf8");
    const needle = JSON.stringify(word.text);
    const match = schemaSource.indexOf(needle);
    if (match < 0) return undefined;
    const schemaDocument = TextDocument.create(pathToFileURL(result.schemaPath).href, "json", 0, schemaSource);
    return {
      uri: schemaDocument.uri,
      range: {
        start: schemaDocument.positionAt(match + 1),
        end: schemaDocument.positionAt(match + needle.length - 1),
      },
    };
  }

  async codeActions(
    document: TextDocument,
    diagnostics: readonly Diagnostic[],
    token?: CancellationLike,
  ): Promise<readonly CodeAction[]> {
    cancelled(token);
    const actions: CodeAction[] = [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.source !== "typed-sql") continue;
      const data = diagnostic.data as { readonly suggestion?: unknown } | undefined;
      const suggestion = typeof data?.suggestion === "string" ? data.suggestion : undefined;
      const replacement =
        suggestion === undefined ? undefined : /^Did you mean ([A-Za-z_$][\w$]*)\?$/u.exec(suggestion)?.[1];
      if (replacement === undefined) continue;
      actions.push({
        title: `Replace with ${replacement}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: { changes: { [document.uri]: [{ range: diagnostic.range, newText: replacement }] } },
      });
    }
    return actions;
  }

  cacheSizes(): { readonly schemas: number; readonly analyses: number; readonly inspections: number } {
    return {
      schemas: this.#schemaCache.size,
      analyses: this.#analysisCache.size,
      inspections: this.#inspectionCache.size,
    };
  }

  async workspaceFiles(token?: CancellationLike): Promise<readonly string[]> {
    cancelled(token);
    const loaded = await this.#config();
    const configuredProjects =
      this.#settings.projectFile === undefined ? (loaded.config.projects ?? []) : [this.#settings.projectFile];
    const projects =
      configuredProjects.length > 0
        ? configuredProjects.map((project) => (isAbsolute(project) ? project : fromConfig(loaded.directory, project)))
        : [await findUp("tsconfig.json", this.#rootDirectory)].filter((value): value is string => value !== undefined);
    const roots = [...new Set(projects.map(dirname))];
    const maximum = this.#settings.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
    const files: string[] = [];
    const excluded = new Set([".git", "node_modules", "dist", "build", "coverage", "target"]);
    const visit = async (directory: string): Promise<void> => {
      if (files.length >= maximum) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        cancelled(token);
        if (files.length >= maximum) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name) && entry.name !== "generated") await visit(path);
        } else if (entry.isFile() && (/\.tsx?$/u.test(entry.name) || /\.[cm]ts$/u.test(entry.name))) files.push(path);
      }
    };
    for (const root of roots) await visit(root);
    return files;
  }

  async handlesWatchedFile(uri: string): Promise<boolean> {
    if (!uri.startsWith("file:")) return false;
    const fileName = resolve(fileURLToPath(uri));
    const loaded = await this.#config();
    const schemaPath =
      this.#settings.schemaPath === undefined
        ? fromConfig(loaded.directory, loaded.config.schema.file)
        : this.#configuredPath(this.#settings.schemaPath);
    return fileName === resolve(loaded.file) || fileName === resolve(schemaPath);
  }

  async close(): Promise<void> {
    const bridge = await this.#nativeBridgePromise;
    this.#nativeBridgePromise = undefined;
    await bridge?.close();
  }

  async #documentAnalysis(document: TextDocument, token?: CancellationLike): Promise<DocumentAnalysis | undefined> {
    cancelled(token);
    if (document.uri.startsWith("file:") === false) return undefined;
    const loaded = await this.#config();
    const schemaPath =
      this.#settings.schemaPath === undefined
        ? fromConfig(loaded.directory, loaded.config.schema.file)
        : this.#configuredPath(this.#settings.schemaPath);
    const schema = await this.#schemaAt(schemaPath);
    cancelled(token);
    const cached = this.#analysisCache.get(document.uri);
    if (
      cached !== undefined &&
      cached.version === document.version &&
      cached.schemaPath === schemaPath &&
      cached.schemaModified === schema.modified
    ) {
      cacheSet(this.#analysisCache, document.uri, cached, this.#maxCacheEntries());
      return cached;
    }
    const fileName = fileURLToPath(document.uri);
    const configuredProjects =
      this.#settings.projectFile === undefined
        ? (loaded.config.projects ?? []).map((project) => fromConfig(loaded.directory, project))
        : [this.#configuredPath(this.#settings.projectFile)];
    const projectFile =
      configuredProjects
        .filter((project) => fileName.startsWith(`${dirname(project)}/`) || fileName === project)
        .sort((left, right) => right.length - left.length)[0] ?? configuredProjects[0];
    const result: DocumentAnalysis = {
      version: document.version,
      schemaPath,
      schemaModified: schema.modified,
      snapshot: schema.snapshot,
      ...(projectFile === undefined ? {} : { projectFile }),
      analysis: analyzeSource(
        document.getText(),
        loaded.config.dialect.validateSnapshot(schema.snapshot),
        loaded.config.dialect,
        loaded.config.typePolicy ?? loaded.config.dialect.defaultTypePolicy,
        loaded.config.compiler,
      ),
    };
    cancelled(token);
    cacheSet(this.#analysisCache, document.uri, result, this.#maxCacheEntries());
    return result;
  }

  async #schemaAt(path: string): Promise<CachedSchema> {
    const file = await stat(path);
    const cached = this.#schemaCache.get(path);
    if (cached !== undefined && cached.modified === file.mtimeMs) {
      cacheSet(this.#schemaCache, path, cached, DEFAULT_MAX_SCHEMA_CACHE_ENTRIES);
      return cached;
    }
    const result = { modified: file.mtimeMs, snapshot: await loadSchemaSnapshot(path) };
    cacheSet(this.#schemaCache, path, result, DEFAULT_MAX_SCHEMA_CACHE_ENTRIES);
    return result;
  }

  #configuredPath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.#rootDirectory, path);
  }

  #nativeBridge(): Promise<NativePreviewTypeScriptBridge> {
    this.#nativeBridgePromise ??= Promise.resolve(NativePreviewTypeScriptBridge.spawn({ cwd: this.#rootDirectory }));
    return this.#nativeBridgePromise;
  }

  #config(): ReturnType<typeof loadConfig> {
    this.#configPromise ??= loadConfig({
      cwd: this.#rootDirectory,
      ...(this.#settings.configPath === undefined ? {} : { file: this.#configuredPath(this.#settings.configPath) }),
    });
    return this.#configPromise;
  }

  #resetNativeBridge(): void {
    const previous = this.#nativeBridgePromise;
    this.#nativeBridgePromise = undefined;
    void previous?.then(async (bridge) => bridge.close()).catch(() => undefined);
  }

  async #nativeInspections(
    document: TextDocument,
    result: DocumentAnalysis,
  ): Promise<readonly NativeTypeInspection[] | undefined> {
    if ((this.#settings.nativePreview ?? defaultSettings.nativePreview) === false) return undefined;
    const key = `${document.uri}@${document.version}:${result.schemaPath}@${result.schemaModified}`;
    const cached = this.#inspectionCache.get(key);
    if (cached !== undefined) {
      cacheSet(this.#inspectionCache, key, cached, this.#maxCacheEntries());
      return cached;
    }
    const inspection = this.#inspect(document, result).catch(() => undefined);
    cacheSet(this.#inspectionCache, key, inspection, this.#maxCacheEntries());
    return inspection;
  }

  async #inspect(document: TextDocument, result: DocumentAnalysis): Promise<readonly NativeTypeInspection[]> {
    const fileName = fileURLToPath(document.uri);
    const projectFile = result.projectFile ?? (await findUp("tsconfig.json", dirname(fileName)));
    const bridge = await this.#nativeBridge();
    return bridge.inspectFile({
      fileName,
      ...(projectFile === undefined ? {} : { projectFile }),
      analysis: result.analysis,
    });
  }

  #maxCacheEntries(): number {
    return this.#settings.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  #validatedSettings(settings: TypedSqlLanguageServerSettings): TypedSqlLanguageServerSettings {
    for (const [name, value] of [
      ["maxCacheEntries", settings.maxCacheEntries],
      ["maxWorkspaceFiles", settings.maxWorkspaceFiles],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new TypeError(`${name} must be a positive safe integer`);
    }
    return settings;
  }

  #wordAt(source: string, offset: number): { readonly text: string } | undefined {
    let start = Math.min(offset, source.length);
    let end = start;
    while (start > 0 && /[A-Za-z0-9_$]/u.test(source[start - 1]!)) start -= 1;
    while (end < source.length && /[A-Za-z0-9_$]/u.test(source[end]!)) end += 1;
    if (start === end) return undefined;
    return { text: source.slice(start, end) };
  }

  #tableForAlias(sql: string, alias: string, snapshot: SchemaSnapshot): TableSnapshot | undefined {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(
      `(?:FROM|JOIN)\\s+(?:[A-Za-z_$][\\w$]*\\.)?([A-Za-z_$][\\w$]*)(?:\\s+(?:AS\\s+)?${escaped})\\b`,
      "iu",
    ).exec(sql);
    const tableName = match?.[1];
    if (tableName === undefined) return undefined;
    return Object.values(snapshot.tables).find((table) => table.name.toLowerCase() === tableName.toLowerCase());
  }
}
