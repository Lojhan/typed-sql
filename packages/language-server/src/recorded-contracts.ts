import { join } from "node:path";
import {
  type AnalysisRegistration,
  createAnalysisContextScope,
  createContractDialect,
  type createLiveContractSession,
  defineAnalysisRegistration,
  exactSqlDigest,
  LiveContextUnavailableError,
  type LiveContractView,
  loadFrozenContractView,
  loadQueryContractInputs,
  loadQueryContracts,
  type NativeContractCandidate,
  openAnalysisCache,
  prepareOfflineContractView,
  type QueryContract,
  type QueryContractContext,
  queryContractDigest,
  readQueryContractManifestDigest,
  selectOfflineAnalysisContext,
} from "@typed-sql/analysis";
import { collectSourceQueryCandidates, collectSqlFileQueryCandidates } from "@typed-sql/compiler";
import { fromConfig, type LoadedConfigSource, resolveConfigDialect, runConfigFactory } from "@typed-sql/config";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";

/** Project-local paths shared with the CLI; frozen mode never opens the disposable cache. */
export function recordedContractPaths(
  loaded: LoadedConfigSource,
): { directory: string; watched: readonly string[] } | undefined {
  if (loaded.config.analysis === undefined) return undefined;
  const {
    live: _live,
    projectCatalogs: _catalogs,
    ...configuration
  } = defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration);
  const directory = fromConfig(loaded.directory, configuration.contractsDir ?? `${loaded.config.outDir}/contracts`);
  const workspace = queryContractDigest({ workspace: loaded.directory, config: loaded.file });
  return {
    directory,
    watched: [
      join(directory, "manifest.json"),
      ...(configuration.mode !== "offline" || !configuration.cache
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
export type LiveEditorSessionInput = Parameters<typeof createLiveContractSession<SchemaSnapshot, unknown>>[0];

export interface RecordedDocumentView {
  readonly dialect: DialectPlugin<SchemaSnapshot, unknown>;
  readonly revision: string;
  readonly schema: SchemaSnapshot;
  readonly files?: readonly string[];
  readonly evidence?: readonly {
    readonly start: number;
    readonly end: number;
    readonly origin: QueryContract["origin"] | "offline-analysis" | "missing-contract";
    readonly contextDigest: string;
  }[];
  assertCurrent(): Promise<void>;
}
/** Prepares only recorded inputs/offline rules. No live factory is called at this boundary. */
export async function prepareRecordedDocument(input: {
  readonly loaded: LoadedConfigSource;
  readonly schema: SchemaSnapshot;
  readonly source: string;
  readonly sqlFile: boolean;
  readonly forceOffline?: boolean;
  readonly live?: (
    options: LiveEditorSessionInput,
    candidates: readonly NativeContractCandidate[],
  ) => Promise<LiveContractView<SchemaSnapshot, unknown>>;
}): Promise<RecordedDocumentView> {
  const { loaded, schema } = input;
  const paths = recordedContractPaths(loaded);
  if (!paths)
    return {
      dialect: (await resolveConfigDialect(loaded)).config.dialect,
      schema,
      revision: "legacy",
      assertCurrent: async () => {},
    };
  const { live, projectCatalogs, ...registered } = defineAnalysisRegistration(
    loaded.config.analysis as AnalysisRegistration,
  );
  const configuration = { ...registered, mode: input.forceOffline ? ("offline" as const) : registered.mode };
  const profile = loaded.config.dialect;
  const typePolicy = loaded.config.typePolicy ?? profile.defaultTypePolicy;
  const manifest = async () =>
    readQueryContractManifestDigest(paths.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" || configuration.mode === "frozen") throw error;
      return null;
    });
  const before = await manifest();
  let candidates: ReturnType<typeof collectSourceQueryCandidates>["candidates"] = [];
  let view: {
    readonly dialect: DialectPlugin<SchemaSnapshot, unknown>;
    readonly context: QueryContractContext;
    readonly contracts: readonly QueryContract[];
    readonly schema?: SchemaSnapshot;
    readonly files?: readonly string[];
    assertCurrent?(): Promise<void>;
  };
  if (configuration.mode === "live") {
    if (!live || !configuration.cache || !input.live)
      throw new TypeError("Live editor analysis requires an explicit native adapter and cache target registration");
    const collection = (input.sqlFile ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
      source: input.source,
      profile,
      schema,
      typePolicy,
      ...loaded.config.compiler,
    });
    candidates = collection.candidates;
    if (
      !collection.complete ||
      collection.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      !collection.candidates.length
    ) {
      const { context: _context, ...unobserved } = configuration;
      const context = await selectOfflineAnalysisContext({
        profile,
        schema,
        typePolicy,
        configuration: { ...unobserved, qualification: { ...unobserved.qualification, mode: "hybrid" } },
      });
      view = { context, contracts: [], dialect: createContractDialect({ profile, context, contracts: [] }) };
    } else {
      const cache = await openAnalysisCache({
        directory: fromConfig(loaded.directory, configuration.cache.directory ?? ".typed-sql/cache/analysis/v1"),
        workspaceContext: queryContractDigest({ workspace: loaded.directory, config: loaded.file }),
      });
      const recordedInputs =
        before !== null
          ? await loadQueryContractInputs(
              paths.directory,
              createAnalysisContextScope({ profile, schema, typePolicy, configuration }),
            )
          : undefined;
      const recordedContext = recordedInputs?.projectCatalogs?.baseContext ?? recordedInputs?.context;
      try {
        const prepared = await input.live(
          {
            profile,
            schema,
            typePolicy,
            configuration,
            cache,
            loadAnalyzer: async () => (await resolveConfigDialect(loaded)).config.dialect,
            ...(recordedContext ? { recordedContext } : {}),
            ...(recordedInputs?.projectCatalogs ? { recordedProjectCatalogs: recordedInputs.projectCatalogs } : {}),
            ...(projectCatalogs
              ? {
                  projectCatalogs: {
                    ...projectCatalogs,
                    loadContributions: () => runConfigFactory(loaded, () => projectCatalogs.loadContributions()),
                  },
                }
              : {}),
            live: {
              ...live,
              adapter: (parameters) =>
                runConfigFactory(loaded, () => live.adapter(parameters), { onDiscard: (services) => services.close() }),
            },
          },
          collection.candidates.map(({ sql, parameterOccurrences }) => ({ sql, parameterOccurrences })),
        );
        if (
          prepared.outcomes.some(
            ({ outcome }) =>
              outcome.kind === "unavailable" ||
              (outcome.kind === "partial" && configuration.qualification.mode === "hybrid"),
          )
        )
          return prepareRecordedDocument({ ...input, forceOffline: true });
        view = prepared;
      } catch (error) {
        if (!(error instanceof LiveContextUnavailableError)) throw error;
        return prepareRecordedDocument({ ...input, forceOffline: true });
      }
    }
  } else if (configuration.mode === "frozen") {
    view = await loadFrozenContractView({
      profile,
      schema,
      typePolicy,
      configuration,
      directory: paths.directory,
      ...(projectCatalogs
        ? { loadProjectCatalogContributions: () => runConfigFactory(loaded, () => projectCatalogs.loadContributions()) }
        : {}),
    });
    candidates = (input.sqlFile ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
      source: input.source,
      profile,
      schema: view.schema ?? schema,
      typePolicy,
      ...loaded.config.compiler,
    }).candidates;
  } else {
    const cache = configuration.cache
      ? await openAnalysisCache({
          directory: fromConfig(loaded.directory, configuration.cache.directory ?? ".typed-sql/cache/analysis/v1"),
          workspaceContext: queryContractDigest({ workspace: loaded.directory, config: loaded.file }),
        })
      : undefined;
    const baseScope = configuration.cache
      ? createAnalysisContextScope({ profile, schema, typePolicy, configuration })
      : undefined;
    const durable = before !== null ? await loadQueryContractInputs(paths.directory, baseScope) : undefined;
    let effectiveSchema = schema;
    let preparedConfiguration = configuration;
    let captured: Awaited<ReturnType<NonNullable<typeof cache>["lookupContext"]>> | undefined;
    let contracts: readonly QueryContract[];
    if (durable?.projectCatalogs) {
      const restored = await loadFrozenContractView({
        profile,
        schema,
        typePolicy,
        configuration,
        directory: paths.directory,
        ...(projectCatalogs
          ? {
              loadProjectCatalogContributions: () =>
                runConfigFactory(loaded, () => projectCatalogs.loadContributions()),
            }
          : {}),
      });
      if (restored.manifestDigest !== before) throw new Error("Catalog inputs changed during editor preparation");
      captured =
        cache && baseScope ? await cache.lookupContext(baseScope, durable.projectCatalogs.baseContext) : undefined;
      if (
        captured?.recorded &&
        (captured.recorded.status !== "usable" ||
          queryContractDigest(captured.recorded.context) !== queryContractDigest(durable.projectCatalogs.baseContext))
      )
        throw new Error("Recorded catalog context is stale; refresh live evidence before offline reuse");
      effectiveSchema = restored.schema;
      preparedConfiguration = restored.configuration;
      contracts = restored.contracts;
    } else {
      const context = await selectOfflineAnalysisContext({
        profile,
        schema,
        typePolicy,
        configuration,
        directory: paths.directory,
        ...(cache ? { cache } : {}),
      });
      captured = cache && baseScope ? await cache.lookupContext(baseScope) : undefined;
      if (
        captured?.recorded &&
        (captured.recorded.status !== "usable" ||
          queryContractDigest(captured.recorded.context) !== queryContractDigest(context))
      )
        throw new Error("Recorded context changed during editor preparation; retry analysis");
      const declared = durable?.context;
      if (
        declared &&
        configuration.context &&
        queryContractDigest(declared) !== queryContractDigest(configuration.context)
      )
        throw new Error("Pinned context differs from the durable target selection");
      preparedConfiguration = { ...configuration, context };
      contracts = configuration.context || declared ? (durable?.contracts ?? []) : [];
    }
    const collection = (input.sqlFile ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
      source: input.source,
      profile,
      schema: effectiveSchema,
      typePolicy,
      ...loaded.config.compiler,
    });
    candidates = collection.candidates;
    // Candidate extraction remains conservative; the compiler reports unsupported source.
    const prepared = await prepareOfflineContractView({
      profile,
      schema: effectiveSchema,
      typePolicy,
      configuration: preparedConfiguration,
      contracts,
      candidates: collection.candidates.map(({ sql, parameterOccurrences }) => ({ sql, parameterOccurrences })),
      ...(cache ? { cache } : {}),
      ...(!durable?.projectCatalogs && projectCatalogs
        ? {
            loadProjectCatalogContributions: () => runConfigFactory(loaded, () => projectCatalogs.loadContributions()),
          }
        : {}),
      loadAnalyzer: async () => (await resolveConfigDialect(loaded)).config.dialect,
    });
    view = {
      ...prepared,
      schema: prepared.schema,
      ...(durable ? { files: durable.files } : {}),
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
  const contextDigest = queryContractDigest(view.context);
  const origins = new Map(
    view.contracts
      .filter((contract) => queryContractDigest(contract.context) === contextDigest)
      .map((contract) => [contract.sqlDigest, contract.origin]),
  );
  return {
    dialect: view.dialect,
    schema: view.schema ?? schema,
    ...(view.files ? { files: view.files } : {}),
    evidence: candidates.map((candidate) => ({
      start: candidate.sourceRange.start,
      end: candidate.sourceRange.end,
      origin:
        origins.get(exactSqlDigest(candidate.sql)) ??
        (configuration.mode === "frozen" ? ("missing-contract" as const) : ("offline-analysis" as const)),
      contextDigest,
    })),
    revision: queryContractDigest({
      context: view.context,
      contracts: view.contracts.map((contract) => contract.digest).sort(),
      manifest: before,
    }),
    assertCurrent,
  };
}
