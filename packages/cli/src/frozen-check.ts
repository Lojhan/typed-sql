import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  defineAnalysisConfiguration,
  loadFrozenContractView,
  loadQueryContracts,
  queryContractDigest,
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
import { fromConfig, type LoadedConfigSource, loadConfigSource } from "@typed-sql/config";
import type { SqlDiagnostic } from "@typed-sql/core";
import { reportCheckedFiles } from "./check-report.js";

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** Explicit frozen host. No cache, analyzer, contribution, provider or native adapter is initialized. */
export async function runFrozenCheck(
  loaded: LoadedConfigSource,
  options: Readonly<Record<string, string>>,
): Promise<void> {
  const raw = defineAnalysisConfiguration(loaded.config.analysis);
  const configuration = defineAnalysisConfiguration({ ...raw, mode: "frozen" });
  const profile = loaded.config.dialect,
    policy = loaded.config.typePolicy ?? profile.defaultTypePolicy;
  const schemaFile = fromConfig(loaded.directory, options.schema ?? loaded.config.schema.file);
  const schemaText = await readFile(schemaFile, "utf8"),
    schema = profile.validateSnapshot(JSON.parse(schemaText));
  const directory = fromConfig(loaded.directory, configuration.contractsDir ?? `${loaded.config.outDir}/contracts`);
  const view = await loadFrozenContractView({ profile, schema, typePolicy: policy, configuration, directory });
  const closure = () =>
    loadQueryContracts(directory).then((contracts) => queryContractDigest(contracts.map((item) => item.digest).sort()));
  const dialect = view.dialect,
    initialClosure = view.digest;
  const file = options.file === undefined ? undefined : resolve(options.file);
  const entryProject =
    file === undefined
      ? undefined
      : options.project === undefined
        ? await findTypeScriptConfig(dirname(file))
        : resolve(options.project);
  if (file !== undefined && entryProject === undefined)
    throw new Error(`Could not find tsconfig.json for frozen file checking`);
  const projects =
    file !== undefined
      ? [entryProject!]
      : options.project === undefined
        ? (loaded.config.projects ?? ["tsconfig.json"]).map((project) => fromConfig(loaded.directory, project))
        : [resolve(options.project)];
  if (!projects.length) throw new Error("Frozen checking requires at least one TypeScript project");
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
    throw new Error("Frozen configuration/schema inputs changed before checking; retry checking.");
  const sourceHashes = new Map<string, string>();
  for (const path of files) sourceHashes.set(await realpath(path), hash(inputs.get(resolve(path))!));
  let invalid = false;
  for (const path of files) {
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
  for (const { file: analyzed, analysis } of analyses) {
    const expected = sourceHashes.get(await realpath(analyzed));
    if (expected === undefined || analysis.identity.source.hash !== expected)
      throw new Error("Frozen project inputs changed after candidate collection; retry checking.");
  }
  for (const [path, text] of inputs)
    if (hash(await readFile(path, "utf8")) !== hash(text))
      throw new Error("Frozen project inputs changed during checking; retry checking.");
  if ((await loadConfigSource({ file: loaded.file })) !== loaded)
    throw new Error("Frozen configuration changed during checking; retry checking.");
  if ((await closure()) !== initialClosure)
    throw new Error("Frozen contract closure changed during checking; retry checking.");
  if (process.exitCode !== 1)
    process.stdout.write(
      `Frozen checked ${projects.length} project(s), ${analyses.reduce((count, item) => count + item.analysis.queries.length, 0)} query(s).\n`,
    );
}
