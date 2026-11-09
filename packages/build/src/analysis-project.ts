import { resolve } from "node:path";
import {
  type AnalysisRegistration,
  createAnalysisContextScope,
  defineAnalysisConfiguration,
  defineAnalysisRegistration,
  loadFrozenContractView,
  loadQueryContractInputs,
  prepareOfflineContractView,
  type QueryContract,
  queryContractDigest,
  readQueryContractManifestDigest,
  selectOfflineAnalysisContext,
} from "@typed-sql/analysis";
import { collectSourceQueryCandidates, collectSqlFileQueryCandidates } from "@typed-sql/compiler";
import { type LoadedConfig, type LoadedConfigSource, resolveConfigDialect, runConfigFactory } from "@typed-sql/config";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";

export interface BuildAnalysis {
  readonly loaded: LoadedConfig;
  readonly files: readonly string[];
  readonly schema: SchemaSnapshot;
  assertCurrent(): Promise<void>;
  prepare(source: string, id: string): Promise<{ readonly dialect: DialectPlugin }>;
}

/** Build inputs are durable artifacts and offline rules; live factories and disposable caches stay idle. */
export async function loadBuildAnalysis(source: LoadedConfigSource, schema: SchemaSnapshot): Promise<BuildAnalysis> {
  const registration = defineAnalysisRegistration(source.config.analysis as AnalysisRegistration);
  const { live: _live, projectCatalogs, ...data } = registration;
  const mode = registration.mode === "frozen" ? "frozen" : "offline";
  let configuration = defineAnalysisConfiguration({ ...data, mode });
  const profile = source.config.dialect;
  const policy = source.config.typePolicy ?? profile.defaultTypePolicy;
  const directory = resolve(source.directory, registration.contractsDir ?? `${source.config.outDir}/contracts`);
  let contracts: readonly QueryContract[] = [];
  let files: readonly string[] = [resolve(directory, "manifest.json")];
  let manifestDigest: string | undefined;
  let initial: { readonly dialect: DialectPlugin };
  if (mode === "frozen") {
    const view = await loadFrozenContractView({
      profile,
      schema,
      typePolicy: policy,
      configuration,
      directory,
      ...(projectCatalogs
        ? { loadProjectCatalogContributions: () => runConfigFactory(source, () => projectCatalogs.loadContributions()) }
        : {}),
    });
    schema = view.schema;
    files = view.files;
    manifestDigest = view.manifestDigest;
    initial = view;
  } else {
    try {
      manifestDigest = await readQueryContractManifestDigest(directory);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    let declared: import("@typed-sql/analysis").QueryContractContext | undefined;
    if (manifestDigest !== undefined) {
      const input = await loadQueryContractInputs(
        directory,
        configuration.cache
          ? createAnalysisContextScope({ profile, schema, typePolicy: policy, configuration })
          : undefined,
      );
      if (input.manifestDigest !== manifestDigest) throw new Error("Build contract inputs changed; retry building");
      contracts = input.contracts;
      files = input.files;
      declared = input.context;
      if (input.projectCatalogs) {
        const view = await loadFrozenContractView({
          profile,
          schema,
          typePolicy: policy,
          configuration,
          directory,
          ...(projectCatalogs
            ? {
                loadProjectCatalogContributions: () =>
                  runConfigFactory(source, () => projectCatalogs.loadContributions()),
              }
            : {}),
        });
        if (view.manifestDigest !== manifestDigest) throw new Error("Build catalog inputs changed; retry building");
        schema = view.schema;
        configuration = view.configuration;
      }
    }
    if (
      configuration.context &&
      declared &&
      queryContractDigest(configuration.context) !== queryContractDigest(declared)
    )
      throw new Error("Pinned build context differs from the durable target selection");
    const context =
      configuration.context ??
      declared ??
      (await selectOfflineAnalysisContext({ profile, schema, typePolicy: policy, configuration }));
    configuration = defineAnalysisConfiguration({ ...configuration, context });
    initial = await prepareOfflineContractView({
      profile,
      schema,
      typePolicy: policy,
      configuration,
      candidates: [],
      contracts,
    });
  }
  const assertCurrent = async () => {
    if (manifestDigest === undefined) {
      try {
        await readQueryContractManifestDigest(directory);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      throw new Error("Build contract inputs changed; retry building");
    }
    // Revalidate the complete immutable closure, including replacements/corruption of referenced objects.
    if ((await loadQueryContractInputs(directory)).manifestDigest !== manifestDigest)
      throw new Error("Build contract inputs changed; retry building");
  };
  const loaded: LoadedConfig = {
    ...source,
    config: Object.freeze({ ...source.config, dialect: initial.dialect }),
    get dependencies() {
      return source.dependencies ?? Object.freeze([]);
    },
  };
  return {
    loaded,
    schema,
    files,
    assertCurrent,
    async prepare(text, id) {
      if (mode === "frozen") return { dialect: initial.dialect };
      const collection = (id.endsWith(".sql") ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
        source: text,
        profile,
        schema,
        typePolicy: policy,
        ...(source.config.compiler?.maxStructuralVariants === undefined
          ? {}
          : { maxStructuralVariants: source.config.compiler.maxStructuralVariants }),
      });
      const view = await prepareOfflineContractView({
        profile,
        schema,
        typePolicy: policy,
        configuration,
        contracts,
        candidates: collection.candidates.map(({ sql, parameterOccurrences }) => ({ sql, parameterOccurrences })),
        loadAnalyzer: async () => (await resolveConfigDialect(source)).config.dialect,
      });
      return { dialect: view.dialect };
    },
  };
}
