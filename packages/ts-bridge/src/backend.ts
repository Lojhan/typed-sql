import type { SourceAnalysisResult } from "@typed-sql/compiler";

export interface TypeScriptBackendIdentity {
  readonly id: string;
  readonly line: string;
  readonly version: string;
  readonly apiStability: "unstable";
}

export interface TypeScriptBackendSpawnOptions {
  readonly cwd?: string;
  readonly tsserverPath?: string;
}

export interface TypeScriptProjectRequest {
  readonly openFiles: readonly string[];
  readonly projectFiles?: readonly string[];
}

/** Serializable identity for an opaque backend-owned project snapshot. */
export interface TypeScriptProjectHandle {
  readonly id: string;
  readonly backend: TypeScriptBackendIdentity;
  readonly openFiles: readonly string[];
  readonly projectFiles: readonly string[];
}

export interface TypeScriptOverlayInput {
  readonly fileName: string;
  readonly projectFile?: string;
  readonly analysis: SourceAnalysisResult;
}

export interface TypeScriptTypeInspection {
  readonly queryIndex: number;
  readonly typeText: string;
}

export interface TypeScriptBackend {
  readonly identity: TypeScriptBackendIdentity;
  loadProject(request: TypeScriptProjectRequest): Promise<TypeScriptProjectHandle>;
  inspectFiles(
    project: TypeScriptProjectHandle,
    inputs: readonly TypeScriptOverlayInput[],
  ): Promise<ReadonlyMap<string, readonly TypeScriptTypeInspection[]>>;
  disposeProject(project: TypeScriptProjectHandle): Promise<void>;
  close(): Promise<void>;
}
