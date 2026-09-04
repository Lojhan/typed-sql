import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromConfig, loadConfig } from "@typed-sql/config";
import type { SchemaSnapshot, TableSnapshot } from "@typed-sql/core";
import { loadSchemaSnapshot } from "@typed-sql/schema";
import {
  analyzeSource,
  type BridgeAnalysis,
  isStaticQueryPosition,
  type NativeTypeInspection,
  queryAtPosition,
  type TypeScriptBridge,
} from "@typed-sql/ts-bridge";
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

export type {
  TypedSqlProtocolCapability,
  TypedSqlProtocolNegotiation,
  TypedSqlProtocolVersionSupport,
} from "./protocol.js";
export {
  negotiateTypedSqlProtocol,
  TYPED_SQL_PROTOCOL_CAPABILITIES,
  TYPED_SQL_PROTOCOL_SUPPORT_POLICY,
  TYPED_SQL_PROTOCOL_VERSION,
  TypedSqlProtocolCompatibilityError,
  typedSqlProtocolVersionSupport,
} from "./protocol.js";

export interface TypedSqlLanguageServerSettings {
  readonly configPath?: string;
  readonly schemaPath?: string;
  readonly projectFile?: string;
  readonly nativePreview?: boolean;
  readonly maxCacheEntries?: number;
  readonly maxWorkspaceFiles?: number;
  readonly analysisDebounceMs?: number;
}

export interface TypedSqlLanguageServiceOptions {
  readonly nativeBridge?: () => TypeScriptBridge;
}

export const TYPED_SQL_STATUS_REQUEST = "typedSql/status";

export interface TypedSqlLanguageServerStatus {
  readonly name: "@typed-sql/language-server";
  readonly mode: "pinned-preview-proxy";
  readonly typescriptVersion: string;
  readonly workspaceRoots: readonly string[];
  readonly openDocuments: number;
  readonly indexedDocuments: number;
  readonly protocol: import("./protocol.js").TypedSqlProtocolNegotiation;
  readonly workspaces: readonly {
    readonly root: string;
    readonly metrics: TypedSqlLanguageServiceMetrics;
  }[];
}

interface CachedSchema {
  readonly modified: number;
  readonly snapshot: SchemaSnapshot;
}

interface DocumentAnalysis {
  readonly version: number;
  readonly generation: number;
  readonly configHash: string;
  readonly schemaPath: string;
  readonly schemaModified: number;
  readonly snapshot: SchemaSnapshot;
  readonly projectFile?: string;
  readonly analysis: BridgeAnalysis;
}

export interface TypedSqlCacheMetrics {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

export interface TypedSqlLanguageServiceMetrics {
  readonly generation: number;
  readonly cache: {
    readonly schemas: TypedSqlCacheMetrics;
    readonly analyses: TypedSqlCacheMetrics;
    readonly inspections: TypedSqlCacheMetrics;
  };
  readonly bridgeRestarts: number;
}

interface CacheCounters {
  hits: number;
  misses: number;
  evictions: number;
}

const defaultSettings: Required<Pick<TypedSqlLanguageServerSettings, "schemaPath" | "nativePreview">> = {
  schemaPath: "src/generated/db/schema.json",
  nativePreview: true,
};
export const DEFAULT_MAX_CACHE_ENTRIES = 256;
export const DEFAULT_MAX_SCHEMA_CACHE_ENTRIES = 16;
export const DEFAULT_MAX_WORKSPACE_FILES = 2_000;
const DEFAULT_ANALYSIS_DEBOUNCE_MS = 20;
const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== "function")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

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

function cacheGet<K, V>(cache: Map<K, V>, key: K, counters: CacheCounters): V | undefined {
  const value = cache.get(key);
  if (value === undefined) counters.misses += 1;
  else counters.hits += 1;
  return value;
}

function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V, maximum: number, counters: CacheCounters): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximum) {
    cache.delete(cache.keys().next().value!);
    counters.evictions += 1;
  }
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

interface DiagnosticFixData {
  readonly title: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly newText: string;
  readonly preferred?: boolean;
}

function diagnosticFix(value: unknown, documentLength: number): DiagnosticFixData | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.title !== "string" || typeof candidate.newText !== "string") return undefined;
  if (typeof candidate.range !== "object" || candidate.range === null) return undefined;
  const range = candidate.range as Record<string, unknown>;
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return undefined;
  const start = range.start as number;
  const end = range.end as number;
  if (start < 0 || end < start || end > documentLength) return undefined;
  return {
    title: candidate.title,
    range: { start, end },
    newText: candidate.newText,
    ...(typeof candidate.preferred === "boolean" ? { preferred: candidate.preferred } : {}),
  };
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
    ...(typeof candidate.analysisDebounceMs === "number" ? { analysisDebounceMs: candidate.analysisDebounceMs } : {}),
  };
}

export class TypedSqlLanguageService {
  #rootDirectory: string;
  #settings: TypedSqlLanguageServerSettings;
  readonly #schemaCache = new Map<string, CachedSchema>();
  readonly #analysisCache = new Map<string, DocumentAnalysis>();
  readonly #inspectionCache = new Map<string, Promise<readonly NativeTypeInspection[] | undefined>>();
  #nativeBridgePromise: Promise<TypeScriptBridge> | undefined;
  readonly #nativeBridgeFactory: () => TypeScriptBridge;
  #configPromise: ReturnType<typeof loadConfig> | undefined;
  #generation = 0;
  #bridgeRestarts = 0;
  readonly #cacheCounters = {
    schemas: { hits: 0, misses: 0, evictions: 0 },
    analyses: { hits: 0, misses: 0, evictions: 0 },
    inspections: { hits: 0, misses: 0, evictions: 0 },
  } satisfies Record<string, CacheCounters>;

  constructor(
    rootDirectory: string,
    settings: TypedSqlLanguageServerSettings = {},
    options: TypedSqlLanguageServiceOptions = {},
  ) {
    this.#rootDirectory = resolve(rootDirectory);
    this.#settings = this.#validatedSettings(settings);
    this.#nativeBridgeFactory =
      options.nativeBridge ?? (() => NativePreviewTypeScriptBridge.spawn({ cwd: this.#rootDirectory }));
  }

  configure(rootDirectory: string, settings: TypedSqlLanguageServerSettings): void {
    this.#rootDirectory = resolve(rootDirectory);
    this.#settings = this.#validatedSettings(settings);
    this.#generation += 1;
    this.#schemaCache.clear();
    this.#analysisCache.clear();
    this.#inspectionCache.clear();
    this.#configPromise = undefined;
    this.#resetNativeBridge();
  }

  invalidate(): void {
    this.#generation += 1;
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
        data: {
          analysisRevision: result.analysis.revision,
          identity: result.analysis.identity,
          ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
          ...(item.fix === undefined ? {} : { fix: item.fix }),
        },
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
    if (!this.isAnalysisCurrent(document, result.analysis)) return undefined;
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
    if (query === undefined || !isStaticQueryPosition(query, offset)) return [];
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
    if (query === undefined || !isStaticQueryPosition(query, offset)) return undefined;
    const word = this.#wordAt(document.getText(), offset);
    if (word === undefined) return undefined;
    cancelled(token);
    const schemaSource = await readFile(result.schemaPath, "utf8");
    if (!this.isAnalysisCurrent(document, result.analysis)) return undefined;
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
    const current = await this.#documentAnalysis(document, token);
    if (current === undefined) return [];
    const actions: CodeAction[] = [];
    const documentLength = document.getText().length;
    for (const diagnostic of diagnostics) {
      if (diagnostic.source !== "typed-sql") continue;
      const data = diagnostic.data as
        | { readonly analysisRevision?: unknown; readonly suggestion?: unknown; readonly fix?: unknown }
        | undefined;
      if (data?.analysisRevision !== undefined && data.analysisRevision !== current.analysis.revision) continue;
      const suggestion = typeof data?.suggestion === "string" ? data.suggestion : undefined;
      const fix = diagnosticFix(data?.fix, documentLength);
      if (fix !== undefined) {
        actions.push({
          title: fix.title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          ...(fix.preferred === undefined ? {} : { isPreferred: fix.preferred }),
          edit: {
            changes: {
              [document.uri]: [
                {
                  range: {
                    start: document.positionAt(fix.range.start),
                    end: document.positionAt(fix.range.end),
                  },
                  newText: fix.newText,
                },
              ],
            },
          },
        });
        continue;
      }
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

  metrics(): TypedSqlLanguageServiceMetrics {
    const metric = (cache: Map<unknown, unknown>, counters: CacheCounters): TypedSqlCacheMetrics =>
      Object.freeze({ entries: cache.size, ...counters });
    return Object.freeze({
      generation: this.#generation,
      cache: Object.freeze({
        schemas: metric(this.#schemaCache, this.#cacheCounters.schemas),
        analyses: metric(this.#analysisCache, this.#cacheCounters.analyses),
        inspections: metric(this.#inspectionCache, this.#cacheCounters.inspections),
      }),
      bridgeRestarts: this.#bridgeRestarts,
    });
  }

  isAnalysisCurrent(document: TextDocument, analysis: BridgeAnalysis): boolean {
    return (
      analysis.identity.project?.generation === this.#generation &&
      analysis.identity.source.id === document.uri &&
      analysis.identity.source.version === document.version &&
      analysis.identity.source.hash === sha256(document.getText())
    );
  }

  async debounce(token?: CancellationLike): Promise<void> {
    cancelled(token);
    const milliseconds = this.#settings.analysisDebounceMs ?? DEFAULT_ANALYSIS_DEBOUNCE_MS;
    if (milliseconds > 0) await wait(milliseconds);
    cancelled(token);
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
    return (
      fileName === resolve(loaded.file) ||
      fileName === resolve(schemaPath) ||
      loaded.dependencies?.includes(fileName) === true
    );
  }

  async close(): Promise<void> {
    const bridge = await this.#nativeBridgePromise;
    this.#nativeBridgePromise = undefined;
    await bridge?.close();
  }

  async #documentAnalysis(document: TextDocument, token?: CancellationLike): Promise<DocumentAnalysis | undefined> {
    while (true) {
      cancelled(token);
      if (document.uri.startsWith("file:") === false) return undefined;
      const generation = this.#generation;
      const loaded = await this.#config();
      if (generation !== this.#generation) continue;
      const schemaPath =
        this.#settings.schemaPath === undefined
          ? fromConfig(loaded.directory, loaded.config.schema.file)
          : this.#configuredPath(this.#settings.schemaPath);
      const schema = await this.#schemaAt(schemaPath);
      if (generation !== this.#generation) {
        this.#schemaCache.clear();
        continue;
      }
      cancelled(token);
      const fileName = fileURLToPath(document.uri);
      const configuredProjects =
        this.#settings.projectFile === undefined
          ? (loaded.config.projects ?? []).map((project) => fromConfig(loaded.directory, project))
          : [this.#configuredPath(this.#settings.projectFile)];
      const projectFile =
        configuredProjects
          .filter((project) => fileName.startsWith(`${dirname(project)}/`) || fileName === project)
          .sort((left, right) => right.length - left.length)[0] ?? configuredProjects[0];
      const [configSource, projectSource] = await Promise.all([
        readFile(loaded.file, "utf8"),
        projectFile === undefined ? undefined : readFile(projectFile, "utf8").catch(() => undefined),
      ]);
      if (generation !== this.#generation) continue;
      const configHash = sha256(
        JSON.stringify(
          canonical({
            configFile: loaded.file,
            configSource,
            projectFile,
            projectSource,
            settings: this.#settings,
            compiler: loaded.config.compiler,
          }),
        ),
      );
      const sourceHash = sha256(document.getText());
      const cached = cacheGet(this.#analysisCache, document.uri, this.#cacheCounters.analyses);
      if (
        cached !== undefined &&
        cached.version === document.version &&
        cached.generation === generation &&
        cached.configHash === configHash &&
        cached.schemaPath === schemaPath &&
        cached.schemaModified === schema.modified &&
        cached.analysis.identity.source.hash === sourceHash
      ) {
        cacheSet(this.#analysisCache, document.uri, cached, this.#maxCacheEntries(), this.#cacheCounters.analyses);
        return cached;
      }
      const analysis = analyzeSource(
        document.getText(),
        loaded.config.dialect.validateSnapshot(schema.snapshot),
        loaded.config.dialect,
        loaded.config.typePolicy ?? loaded.config.dialect.defaultTypePolicy,
        {
          ...loaded.config.compiler,
          sourceId: document.uri,
          sourceVersion: document.version,
          project: {
            id: projectFile ?? loaded.file,
            generation,
            configHash,
          },
          ...(token === undefined ? {} : { cancellation: token }),
        },
      );
      if (generation !== this.#generation) continue;
      const result: DocumentAnalysis = {
        version: document.version,
        generation,
        configHash,
        schemaPath,
        schemaModified: schema.modified,
        snapshot: schema.snapshot,
        ...(projectFile === undefined ? {} : { projectFile }),
        analysis,
      };
      cancelled(token);
      cacheSet(this.#analysisCache, document.uri, result, this.#maxCacheEntries(), this.#cacheCounters.analyses);
      return result;
    }
  }

  async #schemaAt(path: string): Promise<CachedSchema> {
    const file = await stat(path);
    const cached = cacheGet(this.#schemaCache, path, this.#cacheCounters.schemas);
    if (cached !== undefined && cached.modified === file.mtimeMs) {
      cacheSet(this.#schemaCache, path, cached, DEFAULT_MAX_SCHEMA_CACHE_ENTRIES, this.#cacheCounters.schemas);
      return cached;
    }
    const result = { modified: file.mtimeMs, snapshot: await loadSchemaSnapshot(path) };
    cacheSet(this.#schemaCache, path, result, DEFAULT_MAX_SCHEMA_CACHE_ENTRIES, this.#cacheCounters.schemas);
    return result;
  }

  #configuredPath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.#rootDirectory, path);
  }

  #nativeBridge(): Promise<TypeScriptBridge> {
    this.#nativeBridgePromise ??= Promise.resolve(this.#nativeBridgeFactory());
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
    const key = `${document.uri}@${result.analysis.revision}`;
    const cached = cacheGet(this.#inspectionCache, key, this.#cacheCounters.inspections);
    if (cached !== undefined) {
      cacheSet(this.#inspectionCache, key, cached, this.#maxCacheEntries(), this.#cacheCounters.inspections);
      const inspections = await cached;
      return this.isAnalysisCurrent(document, result.analysis) ? inspections : undefined;
    }
    const inspection = this.#inspectWithRecovery(document, result).catch(() => undefined);
    cacheSet(this.#inspectionCache, key, inspection, this.#maxCacheEntries(), this.#cacheCounters.inspections);
    const inspections = await inspection;
    return this.isAnalysisCurrent(document, result.analysis) ? inspections : undefined;
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

  async #inspectWithRecovery(
    document: TextDocument,
    result: DocumentAnalysis,
  ): Promise<readonly NativeTypeInspection[]> {
    try {
      return await this.#inspect(document, result);
    } catch {
      const failed = this.#nativeBridgePromise;
      this.#nativeBridgePromise = undefined;
      this.#bridgeRestarts += 1;
      await failed?.then(async (bridge) => bridge.close()).catch(() => undefined);
      return this.#inspect(document, result);
    }
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
    if (
      settings.analysisDebounceMs !== undefined &&
      (!Number.isSafeInteger(settings.analysisDebounceMs) || settings.analysisDebounceMs < 0)
    )
      throw new TypeError("analysisDebounceMs must be a non-negative safe integer");
    return Object.freeze({ ...settings });
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
