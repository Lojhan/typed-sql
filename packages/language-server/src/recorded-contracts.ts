import { join } from "node:path";
import {
  type AnalysisRegistration,
  createAnalysisContextScope,
  defineAnalysisRegistration,
  loadFrozenContractView,
  loadQueryContractContext,
  loadQueryContracts,
  openAnalysisCache,
  prepareOfflineContractView,
  type QueryContract,
  type QueryContractContext,
  queryContractDigest,
  readQueryContractManifestDigest,
  selectOfflineAnalysisContext,
} from "@typed-sql/analysis";
import { collectSourceQueryCandidates, collectSqlFileQueryCandidates } from "@typed-sql/compiler";
import { fromConfig, type LoadedConfigSource, resolveConfigDialect } from "@typed-sql/config";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";

/** Project-local paths shared with the CLI; frozen mode never opens the disposable cache. */
export function recordedContractPaths(
  loaded: LoadedConfigSource,
): { directory: string; watched: readonly string[] } | undefined {
  if (loaded.config.analysis === undefined) return undefined;
  const { live: _live, ...configuration } = defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration);
  const directory = fromConfig(loaded.directory, configuration.contractsDir ?? `${loaded.config.outDir}/contracts`);
  const workspace = queryContractDigest({ workspace: loaded.directory, config: loaded.file });
  return {
    directory,
    watched: [
      join(directory, "manifest.json"),
      ...(configuration.mode === "frozen" || !configuration.cache
        ? []
        : [
            join(
              fromConfig(loaded.directory, configuration.cache.directory ?? ".typed-sql/cache/analysis/v1"),
              "indexes",
              `${workspace}.json`,
            ),
          ]),
    ],
  };
}
export interface RecordedDocumentView {
  readonly dialect: DialectPlugin<SchemaSnapshot, unknown>;
  readonly revision: string;
  assertCurrent(): Promise<void>;
}
/** Prepares only recorded inputs/offline rules. No live factory is called at this boundary. */
export async function prepareRecordedDocument(input: {
  readonly loaded: LoadedConfigSource;
  readonly schema: SchemaSnapshot;
  readonly source: string;
  readonly sqlFile: boolean;
}): Promise<RecordedDocumentView> {
  const { loaded, schema } = input;
  const paths = recordedContractPaths(loaded);
  if (!paths)
    return {
      dialect: (await resolveConfigDialect(loaded)).config.dialect,
      revision: "legacy",
      assertCurrent: async () => {},
    };
  const { live: _live, ...configuration } = defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration);
  if (configuration.mode === "live")
    throw new Error(
      "Live analysis is not supported by this editor host. Select an offline or frozen editor configuration.",
    );
  const profile = loaded.config.dialect;
  const typePolicy = loaded.config.typePolicy ?? profile.defaultTypePolicy;
  const manifest = async () =>
    readQueryContractManifestDigest(paths.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" || configuration.mode === "frozen") throw error;
      return null;
    });
  const before = await manifest();
  let view: {
    readonly dialect: DialectPlugin<SchemaSnapshot, unknown>;
    readonly context: QueryContractContext;
    readonly contracts: readonly QueryContract[];
    assertCurrent?(): Promise<void>;
  };
  if (configuration.mode === "frozen") {
    view = await loadFrozenContractView({ profile, schema, typePolicy, configuration, directory: paths.directory });
  } else {
    const cache = configuration.cache
      ? await openAnalysisCache({
          directory: fromConfig(loaded.directory, configuration.cache.directory ?? ".typed-sql/cache/analysis/v1"),
          workspaceContext: queryContractDigest({ workspace: loaded.directory, config: loaded.file }),
        })
      : undefined;
    const context = await selectOfflineAnalysisContext({
      profile,
      schema,
      typePolicy,
      configuration,
      directory: paths.directory,
      ...(cache ? { cache } : {}),
    });
    const scope = configuration.cache
      ? createAnalysisContextScope({ profile, schema, typePolicy, configuration })
      : undefined;
    const captured = cache && scope ? await cache.lookupContext(scope) : undefined;
    if (
      captured?.recorded &&
      (captured.recorded.status !== "usable" ||
        queryContractDigest(captured.recorded.context) !== queryContractDigest(context))
    )
      throw new Error("Recorded context changed during editor preparation; retry analysis");
    const declared = before !== null && scope ? await loadQueryContractContext(paths.directory, scope) : undefined;
    if (
      declared &&
      configuration.context &&
      queryContractDigest(declared) !== queryContractDigest(configuration.context)
    )
      throw new Error("Pinned context differs from the durable target selection");
    const collection = (input.sqlFile ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
      source: input.source,
      profile,
      schema,
      typePolicy,
      ...loaded.config.compiler,
    });
    // The normal compiler reports source diagnostics; only fully rendered candidates can reuse evidence.
    let contracts: readonly QueryContract[] = [];
    if (before !== null) {
      contracts = await loadQueryContracts(paths.directory);
    }
    const prepared = await prepareOfflineContractView({
      profile,
      schema,
      typePolicy,
      configuration: { ...configuration, context },
      candidates: collection.candidates.map(({ sql, parameterOccurrences }) => ({ sql, parameterOccurrences })),
      contracts: configuration.context || declared ? contracts : [],
      ...(cache ? { cache } : {}),
      loadAnalyzer: async () => (await resolveConfigDialect(loaded)).config.dialect,
    });
    view = {
      ...prepared,
      async assertCurrent() {
        await prepared.assertCurrent();
        if (cache && captured && !(await cache.areTokensCurrent([captured.token])))
          throw new Error("Recorded context changed during editor analysis");
      },
    };
  }
  const guard = view.assertCurrent ?? (async () => {});
  const assertCurrent = async () => {
    if (before !== null) await loadQueryContracts(paths.directory);
    if ((await manifest()) !== before)
      throw new Error("Query contracts changed during editor analysis; retry analysis");
    await guard();
  };
  await assertCurrent();
  return {
    dialect: view.dialect,
    revision: queryContractDigest({
      context: view.context,
      contracts: view.contracts.map((contract) => contract.digest).sort(),
      manifest: before,
    }),
    assertCurrent,
  };
}
