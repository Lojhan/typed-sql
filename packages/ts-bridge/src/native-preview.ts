import { type Node, type SourceFile, SyntaxKind } from "@typed-sql/typescript-preview/unstable/ast";
import { API, type Checker, type Snapshot } from "@typed-sql/typescript-preview/unstable/async";
import type { BridgeQuery, NativeTypeInspection, TypeScriptBridge, TypeScriptInspectionInput } from "./index.js";

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

  async inspectFile(input: TypeScriptInspectionInput): Promise<readonly NativeTypeInspection[]> {
    return (await this.inspectFiles([input])).get(input.fileName) ?? [];
  }

  async inspectFiles(
    inputs: readonly TypeScriptInspectionInput[],
  ): Promise<ReadonlyMap<string, readonly NativeTypeInspection[]>> {
    if (inputs.length === 0) return new Map();
    const openFiles = [...new Set(inputs.map((input) => input.fileName))];
    const openProjects = [
      ...new Set(inputs.flatMap((input) => (input.projectFile === undefined ? [] : [input.projectFile]))),
    ];
    const snapshot = await this.#api.updateSnapshot(
      this.#fromLanguageServer
        ? undefined
        : {
            openFiles,
            ...(openProjects.length === 0 ? {} : { openProjects }),
          },
    );
    try {
      const result = new Map<string, readonly NativeTypeInspection[]>();
      const withUpdates = async (index: number, current: Snapshot): Promise<void> => {
        const input = inputs[index];
        if (input === undefined) {
          for (const candidate of inputs) {
            const inspections: NativeTypeInspection[] = [];
            const project =
              (candidate.projectFile === undefined
                ? undefined
                : (current.getProject(candidate.projectFile) ??
                  current.getProjects().find((item) => item.configFileName === candidate.projectFile))) ??
              (await current.getDefaultProjectForFile(candidate.fileName)) ??
              current.getProjects()[0];
            if (project === undefined)
              throw new Error(`TypeScript preview did not load a project for ${candidate.fileName}`);
            const sourceFile = await project.program.getSourceFile(candidate.fileName);
            if (sourceFile === undefined) throw new Error(`TypeScript preview did not load ${candidate.fileName}`);
            for (const query of candidate.analysis.queries) {
              inspections.push(await this.#inspectQuery(project.checker, sourceFile, query));
            }
            result.set(candidate.fileName, inspections);
          }
          return;
        }
        await this.#api.runWithTemporaryFileUpdate(
          current,
          input.fileName,
          input.analysis.transformedSource,
          async (updated) => {
            await withUpdates(index + 1, updated);
          },
        );
      };
      await withUpdates(0, snapshot);
      return result;
    } finally {
      await snapshot.dispose();
    }
  }

  async #inspectQuery(checker: Checker, sourceFile: SourceFile, query: BridgeQuery): Promise<NativeTypeInspection> {
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
