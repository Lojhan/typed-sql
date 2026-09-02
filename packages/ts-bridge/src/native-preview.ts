import type { TypeScriptBackend, TypeScriptProjectHandle } from "./backend.js";
import { TypeScript71PreviewBackend } from "./backends/typescript-7.1.js";
import type { NativeTypeInspection, TypeScriptBridge, TypeScriptInspectionInput } from "./index.js";

export { TYPESCRIPT_PREVIEW_VERSION } from "./support.js";

export interface NativePreviewSpawnOptions {
  readonly cwd?: string;
  readonly tsserverPath?: string;
}

/** Compatibility wrapper over the exact version-specific TypeScript backend adapter. */
export class NativePreviewTypeScriptBridge implements TypeScriptBridge {
  readonly #backend: TypeScriptBackend;

  private constructor(backend: TypeScriptBackend) {
    this.#backend = backend;
  }

  get identity(): TypeScriptBackend["identity"] {
    return this.#backend.identity;
  }

  static async connect(pipe: string): Promise<NativePreviewTypeScriptBridge> {
    return new NativePreviewTypeScriptBridge(await TypeScript71PreviewBackend.connect(pipe));
  }

  static spawn(options: NativePreviewSpawnOptions = {}): NativePreviewTypeScriptBridge {
    return new NativePreviewTypeScriptBridge(TypeScript71PreviewBackend.spawn(options));
  }

  async inspectFile(input: TypeScriptInspectionInput): Promise<readonly NativeTypeInspection[]> {
    return (await this.inspectFiles([input])).get(input.fileName) ?? [];
  }

  async inspectFiles(
    inputs: readonly TypeScriptInspectionInput[],
  ): Promise<ReadonlyMap<string, readonly NativeTypeInspection[]>> {
    if (inputs.length === 0) return new Map();
    let project: TypeScriptProjectHandle | undefined;
    try {
      project = await this.#backend.loadProject({
        openFiles: inputs.map(({ fileName }) => fileName),
        projectFiles: inputs.flatMap(({ projectFile }) => (projectFile === undefined ? [] : [projectFile])),
      });
      return await this.#backend.inspectFiles(project, inputs);
    } finally {
      if (project !== undefined) await this.#backend.disposeProject(project);
    }
  }

  close(): Promise<void> {
    return this.#backend.close();
  }
}
