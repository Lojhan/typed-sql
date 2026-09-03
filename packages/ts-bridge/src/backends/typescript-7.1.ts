import { type Node, type SourceFile, SyntaxKind } from "@typed-sql/typescript-preview/unstable/ast";
import { API, type Checker, type Snapshot } from "@typed-sql/typescript-preview/unstable/async";
import type {
  TypeScriptBackend,
  TypeScriptBackendIdentity,
  TypeScriptBackendSpawnOptions,
  TypeScriptOverlayInput,
  TypeScriptProjectHandle,
  TypeScriptProjectRequest,
  TypeScriptTypeInspection,
} from "../backend.js";
import { assertTypeScriptPreviewVersion } from "../compatibility.js";
import { TYPESCRIPT_SUPPORT_POLICY } from "../support.js";

export const TYPESCRIPT_71_BACKEND_IDENTITY: TypeScriptBackendIdentity = Object.freeze({
  id: "typescript-7.1-native-preview",
  line: TYPESCRIPT_SUPPORT_POLICY.previewBackend.line,
  version: TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion,
  apiStability: "unstable",
});

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

export class TypeScript71PreviewBackend implements TypeScriptBackend {
  readonly identity = TYPESCRIPT_71_BACKEND_IDENTITY;
  readonly #api: API<boolean>;
  readonly #fromLanguageServer: boolean;
  readonly #projects = new Map<string, Snapshot>();
  #nextProject = 1;
  #closed = false;

  private constructor(api: API<boolean>, fromLanguageServer: boolean) {
    this.#api = api;
    this.#fromLanguageServer = fromLanguageServer;
  }

  static connect(pipe: string): Promise<TypeScript71PreviewBackend> {
    assertTypeScriptPreviewVersion();
    return API.fromLSPConnection({ pipe }).then((api) => new TypeScript71PreviewBackend(api, true));
  }

  static spawn(options: TypeScriptBackendSpawnOptions = {}): TypeScript71PreviewBackend {
    assertTypeScriptPreviewVersion();
    return new TypeScript71PreviewBackend(new API(options), false);
  }

  async loadProject(request: TypeScriptProjectRequest): Promise<TypeScriptProjectHandle> {
    if (this.#closed) throw new Error("TypeScript backend is closed");
    const openFiles = Object.freeze([...new Set(request.openFiles)]);
    const projectFiles = Object.freeze([...new Set(request.projectFiles ?? [])]);
    if (openFiles.length === 0) throw new TypeError("TypeScript backend requires at least one open file");
    if ([...openFiles, ...projectFiles].some((file) => file.length === 0 || file.includes("\0"))) {
      throw new TypeError("TypeScript backend project paths must be non-empty strings without null bytes");
    }
    const snapshot = await this.#api.updateSnapshot(
      this.#fromLanguageServer
        ? undefined
        : {
            openFiles,
            ...(projectFiles.length === 0 ? {} : { openProjects: projectFiles }),
          },
    );
    const id = `${this.identity.id}:${this.#nextProject++}`;
    this.#projects.set(id, snapshot);
    return Object.freeze({ id, backend: this.identity, openFiles, projectFiles });
  }

  async inspectFiles(
    project: TypeScriptProjectHandle,
    inputs: readonly TypeScriptOverlayInput[],
  ): Promise<ReadonlyMap<string, readonly TypeScriptTypeInspection[]>> {
    const snapshot = this.#projects.get(project.id);
    if (snapshot === undefined || project.backend.id !== this.identity.id) {
      throw new Error("TypeScript backend project is unknown or disposed");
    }
    const openFiles = new Set(project.openFiles);
    if (inputs.some(({ fileName }) => !openFiles.has(fileName))) {
      throw new TypeError("TypeScript overlay input is not part of the loaded project");
    }
    const result = new Map<string, readonly TypeScriptTypeInspection[]>();
    const withUpdates = async (index: number, current: Snapshot): Promise<void> => {
      const input = inputs[index];
      if (input === undefined) {
        for (const candidate of inputs) {
          const inspections: TypeScriptTypeInspection[] = [];
          const selectedProject =
            (candidate.projectFile === undefined
              ? undefined
              : (current.getProject(candidate.projectFile) ??
                current.getProjects().find((item) => item.configFileName === candidate.projectFile))) ??
            (await current.getDefaultProjectForFile(candidate.fileName)) ??
            current.getProjects()[0];
          if (selectedProject === undefined) {
            throw new Error(`TypeScript preview did not load a project for ${candidate.fileName}`);
          }
          const sourceFile = await selectedProject.program.getSourceFile(candidate.fileName);
          if (sourceFile === undefined) throw new Error(`TypeScript preview did not load ${candidate.fileName}`);
          for (const query of candidate.analysis.queries) {
            inspections.push(await this.#inspectQuery(selectedProject.checker, sourceFile, query));
          }
          result.set(candidate.fileName, Object.freeze(inspections));
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
  }

  async disposeProject(project: TypeScriptProjectHandle): Promise<void> {
    const snapshot = this.#projects.get(project.id);
    if (snapshot === undefined) return;
    this.#projects.delete(project.id);
    await snapshot.dispose();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const snapshots = [...this.#projects.values()];
    this.#projects.clear();
    await Promise.allSettled(snapshots.map(async (snapshot) => snapshot.dispose()));
    await this.#api.close();
  }

  async #inspectQuery(
    checker: Checker,
    sourceFile: SourceFile,
    query: TypeScriptOverlayInput["analysis"]["queries"][number],
  ): Promise<TypeScriptTypeInspection> {
    const taggedTemplate = taggedTemplateAt(sourceFile, sourceFile, query.transformedRange.start);
    if (taggedTemplate === undefined) {
      throw new Error(`TypeScript preview could not locate typed-sql query ${query.index}`);
    }
    const type = await checker.getTypeAtLocation(taggedTemplate);
    const typeText = await checker.typeToString(type, taggedTemplate);
    return { queryIndex: query.index, typeText };
  }
}
