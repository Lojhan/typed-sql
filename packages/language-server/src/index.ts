import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { TextDocument } from "vscode-languageserver-textdocument";
import {
  DiagnosticSeverity,
  MarkupKind,
  type Diagnostic,
  type Hover,
} from "vscode-languageserver/node";

export interface TypedSqlLanguageServerSettings {
  readonly configPath?: string;
  readonly schemaPath?: string;
  readonly projectFile?: string;
  readonly nativePreview?: boolean;
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

const defaultSettings: Required<Pick<TypedSqlLanguageServerSettings, "schemaPath" | "nativePreview">> = {
  schemaPath: "src/generated/db/schema.json",
  nativePreview: true,
};

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
  const candidate = typeof nested === "object" && nested !== null
    ? nested as Record<string, unknown>
    : object;
  return {
    ...(typeof candidate.schemaPath === "string" ? { schemaPath: candidate.schemaPath } : {}),
    ...(typeof candidate.configPath === "string" ? { configPath: candidate.configPath } : {}),
    ...(typeof candidate.projectFile === "string" ? { projectFile: candidate.projectFile } : {}),
    ...(typeof candidate.nativePreview === "boolean" ? { nativePreview: candidate.nativePreview } : {}),
  };
}

export class TypedSqlLanguageService {
  #rootDirectory: string;
  #settings: TypedSqlLanguageServerSettings;
  readonly #schemaCache = new Map<string, CachedSchema>();
  readonly #analysisCache = new Map<string, DocumentAnalysis>();
  readonly #inspectionCache = new Map<string, Promise<readonly NativeTypeInspection[] | undefined>>();
  #nativeBridgePromise: Promise<NativePreviewTypeScriptBridge> | undefined;

  constructor(rootDirectory: string, settings: TypedSqlLanguageServerSettings = {}) {
    this.#rootDirectory = resolve(rootDirectory);
    this.#settings = settings;
  }

  configure(rootDirectory: string, settings: TypedSqlLanguageServerSettings): void {
    this.#rootDirectory = resolve(rootDirectory);
    this.#settings = settings;
    this.#schemaCache.clear();
    this.#analysisCache.clear();
    this.#inspectionCache.clear();
  }

  invalidate(): void {
    this.#schemaCache.clear();
    this.#analysisCache.clear();
    this.#inspectionCache.clear();
  }

  forget(uri: string): void {
    this.#analysisCache.delete(uri);
    for (const key of this.#inspectionCache.keys()) {
      if (key.startsWith(`${uri}@`)) this.#inspectionCache.delete(key);
    }
  }

  async diagnostics(document: TextDocument): Promise<readonly Diagnostic[]> {
    const result = await this.#documentAnalysis(document);
    if (result === undefined) return [];
    return result.analysis.diagnostics.map((item): Diagnostic => ({
      range: {
        start: document.positionAt(item.range.start),
        end: document.positionAt(item.range.end),
      },
      message: `${item.code}: ${item.message}`,
      severity: severity(item.severity),
      source: "typed-sql",
      code: item.code,
    }));
  }

  async analysis(document: TextDocument): Promise<BridgeAnalysis | undefined> {
    return (await this.#documentAnalysis(document))?.analysis;
  }

  async hover(document: TextDocument, position: { readonly line: number; readonly character: number }): Promise<Hover | undefined> {
    const result = await this.#documentAnalysis(document);
    if (result === undefined) return undefined;
    const offset = document.offsetAt(position);
    const query = queryAtPosition(result.analysis, offset);
    if (query === undefined) return undefined;
    const inspections = await this.#nativeInspections(document, result);
    const nativeType = inspections?.find((inspection) => inspection.queryIndex === query.index)?.typeText;
    const range = query.binding !== undefined
      && offset >= query.binding.range.start
      && offset <= query.binding.range.end
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

  async close(): Promise<void> {
    const bridge = await this.#nativeBridgePromise;
    this.#nativeBridgePromise = undefined;
    await bridge?.close();
  }

  async #documentAnalysis(document: TextDocument): Promise<DocumentAnalysis | undefined> {
    if (document.uri.startsWith("file:") === false) return undefined;
    const loaded = await loadConfig({
      cwd: this.#rootDirectory,
      ...(this.#settings.configPath === undefined ? {} : { file: this.#configuredPath(this.#settings.configPath) }),
    });
    const schemaPath = this.#settings.schemaPath === undefined
      ? fromConfig(loaded.directory, loaded.config.schema.file)
      : this.#configuredPath(this.#settings.schemaPath);
    const schema = await this.#schemaAt(schemaPath);
    const cached = this.#analysisCache.get(document.uri);
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
    this.#analysisCache.set(document.uri, result);
    return result;
  }

  async #schemaAt(path: string): Promise<CachedSchema> {
    const file = await stat(path);
    const cached = this.#schemaCache.get(path);
    if (cached !== undefined && cached.modified === file.mtimeMs) return cached;
    const result = { modified: file.mtimeMs, snapshot: await loadSchemaSnapshot(path) };
    this.#schemaCache.set(path, result);
    return result;
  }

  #configuredPath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.#rootDirectory, path);
  }

  #nativeBridge(): Promise<NativePreviewTypeScriptBridge> {
    this.#nativeBridgePromise ??= Promise.resolve(NativePreviewTypeScriptBridge.spawn({ cwd: this.#rootDirectory }));
    return this.#nativeBridgePromise;
  }

  async #nativeInspections(
    document: TextDocument,
    result: DocumentAnalysis,
  ): Promise<readonly NativeTypeInspection[] | undefined> {
    if ((this.#settings.nativePreview ?? defaultSettings.nativePreview) === false) return undefined;
    const key = `${document.uri}@${document.version}:${result.schemaPath}@${result.schemaModified}`;
    const cached = this.#inspectionCache.get(key);
    if (cached !== undefined) return cached;
    const inspection = this.#inspect(document, result).catch(() => undefined);
    this.#inspectionCache.set(key, inspection);
    return inspection;
  }

  async #inspect(document: TextDocument, result: DocumentAnalysis): Promise<readonly NativeTypeInspection[]> {
    const fileName = fileURLToPath(document.uri);
    const configuredProject = this.#settings.projectFile;
    const projectFile = configuredProject === undefined
      ? await findUp("tsconfig.json", dirname(fileName))
      : this.#configuredPath(configuredProject);
    const bridge = await this.#nativeBridge();
    return bridge.inspectFile({
      fileName,
      ...(projectFile === undefined ? {} : { projectFile }),
      analysis: result.analysis,
    });
  }
}
