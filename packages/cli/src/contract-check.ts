import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type AnalysisRegistration,
  createAnalysisContextScope,
  createContractDialect,
  createQueryContractIndex,
  defineAnalysisConfiguration,
  defineAnalysisRegistration,
  exportQueryContracts,
  loadFrozenContractView,
  loadQueryContractContext,
  loadQueryContracts,
  openAnalysisCache,
  prepareLiveContractView,
  prepareOfflineContractView,
  type QueryContract,
  queryContractDigest,
  queryContractManifestDigest,
  readQueryContractManifestDigest,
  selectOfflineAnalysisContext,
} from "@typed-sql/analysis";
import {
  checkFile,
  checkProject,
  collectSourceQueryCandidates,
  collectSqlFileQueryCandidates,
  findTypeScriptConfig,
  listProjectSourceFiles,
  mapSqlRange,
  type SourceAnalysisResult,
} from "@typed-sql/compiler";
import {
  fromConfig,
  type LoadedConfigSource,
  loadConfigSource,
  resolveConfigDialect,
  runConfigFactory,
} from "@typed-sql/config";
import type { SqlDiagnostic } from "@typed-sql/core";
import { reportCheckedFiles } from "./check-report.js";
import { materializeOfflineContract } from "./offline-contract.js";

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** Explicit artifact-aware host. Network access is never initiated by offline/frozen checks. */
export async function runContractCommand(
  loaded: LoadedConfigSource,
  options: Readonly<Record<string, string>>,
): Promise<void> {
  const generating = options.queries === "true";
  if (generating && options.file !== undefined)
    throw new Error("Query generation requires complete projects; use --project or config.projects");
  const { live, ...data } = defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration);
  const raw = defineAnalysisConfiguration(data);
  let configuration = defineAnalysisConfiguration({
    ...raw,
    ...(options.qualification === undefined
      ? {}
      : { qualification: { ...raw.qualification, mode: options.qualification } }),
    mode:
      options.frozen === "true"
        ? "frozen"
        : options.offline === "true"
          ? "offline"
          : options.live === "true"
            ? "live"
            : raw.mode,
  });
  if (configuration.mode === "live" && (!live || !configuration.cache))
    throw new Error("Live checking requires analysis.live.adapter and an explicit analysis.cache target identity.");
  const profile = loaded.config.dialect,
    policy = loaded.config.typePolicy ?? profile.defaultTypePolicy;
  const schemaFile = fromConfig(loaded.directory, options.schema ?? loaded.config.schema.file);
  const schemaText = await readFile(schemaFile, "utf8"),
    schema = profile.validateSnapshot(JSON.parse(schemaText));
  const directory = fromConfig(
    loaded.directory,
    (generating ? options.out : undefined) ?? configuration.contractsDir ?? `${loaded.config.outDir}/contracts`,
  );
  const manifestDigest = () =>
    readQueryContractManifestDigest(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
  const baselineManifest = await manifestDigest();
  const expectedManifestDigest = generating ? baselineManifest : undefined;
  const durable = async () => {
    if (configuration.mode !== "frozen") {
      try {
        await lstat(resolve(directory, "manifest.json"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    }
    return loadQueryContracts(directory);
  };
  const initialContracts = await durable();
  if (generating && expectedManifestDigest !== (await manifestDigest()))
    throw new Error("Query contract manifest changed before generation; retry generation");
  const closure = async () => queryContractDigest((await durable()).map((item) => item.digest).sort());
  const initialClosure = queryContractDigest(initialContracts.map((item) => item.digest).sort());
  const file = options.file === undefined ? undefined : resolve(options.file);
  const entryProject =
    file === undefined
      ? undefined
      : options.project === undefined
        ? await findTypeScriptConfig(dirname(file))
        : resolve(options.project);
  if (file !== undefined && entryProject === undefined)
    throw new Error(`Could not find tsconfig.json for artifact-aware file checking`);
  const projects =
    file !== undefined
      ? [entryProject!]
      : options.project === undefined
        ? (loaded.config.projects ?? ["tsconfig.json"]).map((project) => fromConfig(loaded.directory, project))
        : [resolve(options.project)];
  if (!projects.length) throw new Error("Artifact-aware checking requires at least one TypeScript project");
  const files = [
    ...new Set(
      (
        await Promise.all(
          projects.map((project) =>
            listProjectSourceFiles({
              project,
              cwd: loaded.directory,
              includeSqlAssets: true,
              ...(file === undefined ? {} : { entryFile: file }),
            }),
          ),
        )
      ).flat(),
    ),
  ].sort();
  const inputs = new Map(
    await Promise.all(
      [...new Set([...files, schemaFile, loaded.file, ...(loaded.dependencies ?? []), ...projects])].map(
        async (path) => [resolve(path), await readFile(path, "utf8")] as const,
      ),
    ),
  );
  if (inputs.get(resolve(schemaFile)) !== schemaText || (await loadConfigSource({ file: loaded.file })) !== loaded)
    throw new Error("Analysis configuration/schema inputs changed before checking; retry checking.");
  const sourceHashes = new Map<string, string>();
  for (const path of files) sourceHashes.set(await realpath(path), hash(inputs.get(resolve(path))!));
  const collections = files.map((path) => {
    const source = inputs.get(resolve(path))!;
    const collection = (/\.sql$/iu.test(path) ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
      source,
      profile,
      schema,
      typePolicy: policy,
      ...(loaded.config.compiler?.maxStructuralVariants === undefined
        ? {}
        : { maxStructuralVariants: loaded.config.compiler.maxStructuralVariants }),
    });
    return { path, source, collection };
  });
  if (
    collections.some(({ collection }) => collection.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
  ) {
    for (const { path, collection } of collections)
      for (const diagnostic of collection.diagnostics)
        process.stderr.write(
          `${path}:${diagnostic.range.line}:${diagnostic.range.column} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
        );
    process.exitCode = 1;
    return;
  }
  const cache =
    configuration.mode !== "frozen" && configuration.cache
      ? await openAnalysisCache({
          directory: fromConfig(loaded.directory, configuration.cache.directory ?? ".typed-sql/cache/analysis/v1"),
          workspaceContext: queryContractDigest({ workspace: loaded.directory, config: loaded.file }),
        })
      : undefined;
  const bindingScope = configuration.cache
    ? createAnalysisContextScope({ profile, schema, typePolicy: policy, configuration })
    : undefined;
  const automaticScope = raw.context === undefined ? bindingScope! : undefined;
  const recordedContext =
    bindingScope && baselineManifest !== null ? await loadQueryContractContext(directory, bindingScope) : undefined;
  if (
    recordedContext &&
    configuration.context &&
    queryContractDigest(recordedContext) !== queryContractDigest(configuration.context)
  )
    throw new Error("Pinned context differs from the durable target selection");
  let selectionToken: import("@typed-sql/analysis").AnalysisCacheToken | undefined;
  if (automaticScope && configuration.mode === "offline") {
    const context = await selectOfflineAnalysisContext({
      profile,
      schema,
      typePolicy: policy,
      configuration,
      ...(cache ? { cache } : {}),
      ...(baselineManifest !== null ? { directory } : {}),
    });
    configuration = defineAnalysisConfiguration({ ...configuration, context });
    if (cache) {
      const captured = await cache.lookupContext(automaticScope);
      if (
        captured.recorded &&
        (captured.recorded.status === "stale" ||
          queryContractDigest(captured.recorded.context) !== queryContractDigest(context))
      )
        throw new Error("Analysis target/context selection changed; retry current inputs");
      selectionToken = captured.token;
    }
  }
  const view =
    configuration.mode === "frozen"
      ? await loadFrozenContractView({ profile, schema, typePolicy: policy, configuration, directory })
      : configuration.mode === "live"
        ? await prepareLiveContractView({
            profile,
            schema,
            typePolicy: policy,
            configuration,
            cache: cache!,
            ...(recordedContext ? { recordedContext } : {}),
            live: {
              ...live!,
              adapter: (input) =>
                runConfigFactory(loaded, () => live!.adapter(input), { onDiscard: (services) => services.close() }),
            },
            candidates: collections.flatMap(({ collection }) =>
              collection.candidates.map(({ sql, parameterOccurrences }) => ({ sql, parameterOccurrences })),
            ),
            loadAnalyzer: async () => (await resolveConfigDialect(loaded)).config.dialect,
          })
        : await prepareOfflineContractView({
            profile,
            schema,
            typePolicy: policy,
            configuration,
            contracts: automaticScope && !recordedContext ? [] : initialContracts,
            candidates: collections.flatMap(({ collection }) =>
              collection.candidates.map((candidate) => ({
                sql: candidate.sql,
                parameterOccurrences: candidate.parameterOccurrences,
              })),
            ),
            ...(cache ? { cache } : {}),
            loadAnalyzer: async () => (await resolveConfigDialect(loaded)).config.dialect,
          });
  const context = view.context;
  const selection = bindingScope ? { scope: bindingScope, context } : undefined;
  let dialect = view.dialect;
  const generated: QueryContract[] = [];
  if (generating) {
    const index = createQueryContractIndex(view.contracts),
      selected = new Map<string, QueryContract>();
    for (const { path, collection } of collections)
      for (const candidate of collection.candidates) {
        if (selected.has(candidate.sql)) continue;
        let contract = index.resolve(context, candidate.sql);
        if (!contract) {
          if (configuration.qualification.mode !== "hybrid")
            throw new Error("Native-required query generation requires qualified contracts for every candidate");
          try {
            contract = materializeOfflineContract({
              sql: candidate.sql,
              context,
              dialect,
              schema,
              typePolicy: policy,
              parameterCount: Math.max(0, ...candidate.parameterOccurrences.map(({ index }) => index)),
            });
          } catch (error) {
            throw new Error(
              `${path}:${candidate.sourceRange.line}:${candidate.sourceRange.column}: ${error instanceof Error ? error.message : "Offline contract generation failed"}`,
            );
          }
        }
        selected.set(candidate.sql, contract);
      }
    generated.push(...selected.values());
    dialect = createContractDialect({
      profile,
      context,
      contracts: generated,
      ...(configuration.qualification.mode === "native-required"
        ? { qualificationPolicyHash: queryContractDigest(configuration.qualification) }
        : {}),
    });
  }
  for (const path of loaded.dependencies ?? [])
    if (!inputs.has(resolve(path))) inputs.set(resolve(path), await readFile(path, "utf8"));
  let invalid = false;
  for (const { path, source, collection } of collections) {
    const report = (diagnostic: SqlDiagnostic) => {
      if (diagnostic.severity === "error") invalid = true;
      process.stderr.write(
        `${path}:${diagnostic.range.line}:${diagnostic.range.column} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
      );
    };
    for (const diagnostic of collection.diagnostics) report(diagnostic);
    for (const candidate of collection.candidates)
      for (const diagnostic of dialect.analyze(candidate.sql, schema, policy, { runtimeValidation: true }).diagnostics)
        report({
          ...diagnostic,
          range: mapSqlRange(
            source,
            { range: candidate.sourceRange, sqlOffsetMap: candidate.sqlOffsetMap },
            diagnostic.range,
          ),
        });
  }
  if (invalid) {
    process.exitCode = 1;
    return;
  }
  const common = {
    dialect,
    schema,
    typePolicy: policy,
    ...(loaded.config.compiler?.maxStructuralVariants === undefined
      ? {}
      : { maxStructuralVariants: loaded.config.compiler.maxStructuralVariants }),
  };
  const analyses: { readonly file: string; readonly analysis: SourceAnalysisResult }[] = [];
  for (const project of projects) {
    const result =
      file === undefined ? await checkProject({ ...common, project }) : await checkFile({ ...common, project, file });
    const checked = result.files ?? ("analysis" in result ? [{ file: file!, analysis: result.analysis }] : []);
    analyses.push(...checked);
    reportCheckedFiles({
      files: checked,
      output: "typeScript" in result ? (result.typeScript?.output ?? "") : "",
      ok: result.ok,
      directory: loaded.directory,
      showTypes: options["show-types"] === "true",
    });
  }
  const assertInputs = async () => {
    if ("assertCurrent" in view) await view.assertCurrent();
    if (selectionToken && cache && !(await cache.areTokensCurrent([selectionToken])))
      throw new Error("Analysis target/context selection changed; retry current inputs");
    for (const { file: analyzed, analysis } of analyses) {
      const expected = sourceHashes.get(await realpath(analyzed));
      if (expected === undefined || analysis.identity.source.hash !== expected)
        throw new Error("Analysis project inputs changed after candidate collection; retry checking.");
    }
    for (const [path, text] of inputs)
      if (hash(await readFile(path, "utf8")) !== hash(text))
        throw new Error("Analysis project inputs changed during checking; retry checking.");
    if ((await loadConfigSource({ file: loaded.file })) !== loaded)
      throw new Error("Analysis configuration changed during checking; retry checking.");
    if ((await closure()) !== initialClosure)
      throw new Error("Analysis contract closure changed during checking; retry checking.");
  };
  await assertInputs();
  if (generating) {
    if (process.exitCode === 1) return;
    const digest = queryContractManifestDigest(generated, selection ? { selection } : {});
    if (options.check === "true") {
      if (digest !== expectedManifestDigest) {
        process.stderr.write("Query contract export differs from the durable manifest; regenerate and review it.\n");
        process.exitCode = 1;
      } else process.stdout.write(`Query contract export matches ${digest} (${generated.length} contract(s)).\n`);
    } else {
      await exportQueryContracts(directory, generated, {
        expectedManifestDigest: expectedManifestDigest ?? null,
        beforeCommit: assertInputs,
        ...(selection ? { selection } : {}),
      });
      process.stdout.write(`Generated ${generated.length} query contract(s) at ${directory} (${digest}).\n`);
    }
    return;
  }
  if (process.exitCode !== 1)
    process.stdout.write(
      `${configuration.mode === "frozen" ? "Frozen" : configuration.mode === "live" ? "Live" : "Offline"} checked ${projects.length} project(s), ${analyses.reduce((count, item) => count + item.analysis.queries.length, 0)} query(s).\n`,
    );
}
