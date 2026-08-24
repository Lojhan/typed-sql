import { API, type Checker } from "@typed-sql/typescript-preview/unstable/async";
import { SyntaxKind, type Node, type SourceFile } from "@typed-sql/typescript-preview/unstable/ast";
import type {
  BridgeAnalysis,
  BridgeQuery,
  NativeTypeInspection,
  TypeScriptBridge,
} from "./index.js";

export const TYPESCRIPT_PREVIEW_VERSION = "7.1.0-dev.20260824.1";

export interface NativePreviewSpawnOptions {
  readonly cwd?: string;
  readonly tsserverPath?: string;
}

function taggedTemplateAt(node: Node, sourceFile: SourceFile, start: number): Node | undefined {
  if (node.kind === SyntaxKind.TaggedTemplateExpression && node.getStart(sourceFile) === start) return node;
  let result: Node | undefined;
  node.forEachChild((child) => {
    if (result === undefined && child.pos <= start && child.end >= start) {
      result = taggedTemplateAt(child, sourceFile, start);
    }
  });
  return result;
}

export class NativePreviewTypeScriptBridge implements TypeScriptBridge {
  readonly #api: API<boolean>;
  readonly #fromLanguageServer: boolean;

  private constructor(api: API<boolean>, fromLanguageServer: boolean) {
    this.#api = api;
    this.#fromLanguageServer = fromLanguageServer;
  }

  static async connect(pipe: string): Promise<NativePreviewTypeScriptBridge> {
    const api = await API.fromLSPConnection({ pipe });
    return new NativePreviewTypeScriptBridge(api, true);
  }

  static spawn(options: NativePreviewSpawnOptions = {}): NativePreviewTypeScriptBridge {
    return new NativePreviewTypeScriptBridge(new API(options), false);
  }

  async inspectFile(input: {
    readonly fileName: string;
    readonly projectFile?: string;
    readonly analysis: BridgeAnalysis;
  }): Promise<readonly NativeTypeInspection[]> {
    const snapshot = await this.#api.updateSnapshot(this.#fromLanguageServer
      ? undefined
      : {
          openFiles: [input.fileName],
          ...(input.projectFile === undefined ? {} : { openProjects: [input.projectFile] }),
        });
    try {
      const inspections: NativeTypeInspection[] = [];
      await this.#api.runWithTemporaryFileUpdate(
        snapshot,
        input.fileName,
        input.analysis.transformedSource,
        async (temporarySnapshot) => {
          const project = await temporarySnapshot.getDefaultProjectForFile(input.fileName)
            ?? temporarySnapshot.getProjects()[0];
          if (project === undefined) throw new Error(`TypeScript preview did not load a project for ${input.fileName}`);
          const sourceFile = await project.program.getSourceFile(input.fileName);
          if (sourceFile === undefined) throw new Error(`TypeScript preview did not load ${input.fileName}`);
          for (const query of input.analysis.queries) {
            inspections.push(await this.#inspectQuery(project.checker, sourceFile, query));
          }
        },
      );
      return inspections;
    } finally {
      await snapshot.dispose();
    }
  }

  async #inspectQuery(
    checker: Checker,
    sourceFile: SourceFile,
    query: BridgeQuery,
  ): Promise<NativeTypeInspection> {
    const taggedTemplate = taggedTemplateAt(sourceFile, sourceFile, query.transformedRange.start);
    if (taggedTemplate === undefined) {
      throw new Error(`TypeScript preview could not locate typed-sql query ${query.index}`);
    }
    const type = await checker.getTypeAtLocation(taggedTemplate);
    const typeText = await checker.typeToString(type, taggedTemplate);
    return { queryIndex: query.index, typeText };
  }

  async close(): Promise<void> {
    await this.#api.close();
  }
}
