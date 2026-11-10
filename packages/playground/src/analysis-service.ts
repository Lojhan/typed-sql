import {
  type AnalysisRegistration,
  createLiveContractSession,
  defineAnalysisRegistration,
  type LiveContractSession,
  queryContractDigest,
} from "@typed-sql/analysis";
import { prepareRecordedDocument, type RecordedDocumentView } from "@typed-sql/build/analysis";
import { type LoadedConfigSource, loadConfigSource } from "@typed-sql/config";
import type { SchemaSnapshot } from "@typed-sql/core";
import { WorkspaceError } from "./files.js";

/** One owned native session per workspace, with source versions and close/trust fences. */
export class WorkspaceAnalysis {
  private session: LiveContractSession<SchemaSnapshot, unknown> | undefined;
  private sessionKey: string | undefined;
  private loaded: LoadedConfigSource | undefined;
  private version = 0;
  private generation = 0;
  private stopped = false;
  constructor(
    private readonly config: string,
    private readonly trusted: () => boolean,
  ) {}
  async prepare(
    file: string,
    source: string,
    schema: SchemaSnapshot,
    sources?: readonly { readonly source: string; readonly sqlFile: boolean }[],
  ): Promise<RecordedDocumentView> {
    if (this.stopped) throw new WorkspaceError("ANALYSIS_CLOSED", "Workspace analysis is closed", 503);
    const generation = this.generation;
    const loaded = await loadConfigSource({ file: this.config });
    if (this.loaded && this.loaded !== loaded)
      throw new WorkspaceError("CONFIG_CHANGED", "Configuration changed. Restart the workspace before analysis", 409);
    this.loaded = loaded;
    const version = ++this.version;
    const view = await prepareRecordedDocument({
      loaded,
      schema,
      source,
      sqlFile: file.endsWith(".sql"),
      ...(sources ? { sources } : {}),
      forceOffline:
        !this.trusted() &&
        loaded.config.analysis !== undefined &&
        defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration).mode === "live",
      live: async (options, candidates) => {
        if (!this.trusted() || generation !== this.generation)
          throw new WorkspaceError("TRUST_REQUIRED", "Trust this project before native analysis", 403);
        const key = queryContractDigest({
          schema: options.schema,
          configuration: options.configuration,
          recordedContext: options.recordedContext ?? null,
          catalogs: options.recordedProjectCatalogs ?? null,
        });
        if (this.sessionKey !== key) {
          const previous = this.session;
          this.session = undefined;
          await previous?.close();
          if (!this.trusted() || generation !== this.generation)
            throw new WorkspaceError("ANALYSIS_STALE", "Workspace analysis changed; retry the request", 409);
          this.sessionKey = key;
        }
        this.session ??= createLiveContractSession(options);
        return this.session.prepare({ document: file, version, candidates });
      },
    });
    const assertCurrent = async () => {
      if (this.stopped || generation !== this.generation)
        throw new WorkspaceError("ANALYSIS_STALE", "Workspace analysis changed; retry the request", 409);
      if ((await loadConfigSource({ file: this.config })) !== loaded)
        throw new WorkspaceError("CONFIG_CHANGED", "Configuration changed. Restart the workspace", 409);
      await view.assertCurrent();
    };
    await assertCurrent();
    return { ...view, assertCurrent };
  }
  async reset(): Promise<void> {
    this.generation++;
    const session = this.session;
    this.session = undefined;
    this.sessionKey = undefined;
    await session?.close();
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.reset();
  }
}
