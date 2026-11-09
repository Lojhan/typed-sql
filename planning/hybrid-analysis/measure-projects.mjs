import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
  createQueryContract,
  exportQueryContracts,
  loadQueryContracts,
  queryContractDigest,
} from "../../packages/analysis/src/index.ts";
import {
  buildQueryValuePlan,
  collectSourceQueryCandidates,
  collectSqlFileQueryCandidates,
  compileSource,
} from "../../packages/compiler/src/index.ts";
import {
  calculateSchemaHash,
  calculateTypePolicyHash,
  defineSchemaSnapshotV2,
  serializeSchemaSnapshot,
} from "../../packages/schema/src/index.ts";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.ts";
import { analyzeSqlFiles } from "../../website/.vitepress/theme/playground/workspace-sql.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "packages/build/package.json"));
const esbuild = require("esbuild");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function unresolvedType(type) {
  if (type === "unknown") return true;
  if (typeof type === "string" || "json" in type || "literal" in type) return false;
  if ("array" in type) return unresolvedType(type.array);
  if ("object" in type) return Object.values(type.object).some((field) => unresolvedType(field.type));
  if ("tuple" in type) return type.tuple.some((field) => unresolvedType(field.type));
  return type.union.some(unresolvedType);
}
// JSON descriptors choose their own codec even when the scalar fallback is unknown.
const unresolvedCodec = (value) => value.json === undefined && unresolvedType(value.type);
const sizes = (value) => {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : Buffer.from(value);
  return {
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
    brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    digest: hash(bytes),
  };
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", "packages", "examples", "website", "pnpm-lock.yaml");
if (dirty) throw Error("Project measurements require clean library and corpus sources");
const revision = git("rev-parse", "HEAD");
const grammars = Object.keys(
  JSON.parse(await readFile(join(root, "grammar/features/ledger.json"), "utf8")).dialects,
).sort();
const rows = [],
  inputs = new Map();
const one = (module, suffix) => {
  const matches = Object.keys(module).filter((name) => name.endsWith(suffix) && typeof module[name] === "function");
  if (matches.length !== 1) throw Error(`Ambiguous ${suffix} owner discovery`);
  return module[matches[0]];
};
async function filesAt(directory, prefix = "") {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...(await filesAt(join(directory, entry.name), `${name}/`)));
    else if (entry.isFile()) files.push([name, await readFile(join(directory, entry.name))]);
  }
  return files;
}
async function bundle(modules, firstOnly = false) {
  const names = Object.keys(modules).sort();
  const barrel = names
    .map((name, index) => `export * as query_${index} from ${JSON.stringify(`project:${name}`)};`)
    .join("\n");
  const result = await esbuild.build({
    stdin: {
      contents: firstOnly ? 'export {query_0} from "project:__barrel";' : 'export * from "project:__barrel";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    minify: true,
    treeShaking: true,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "commerce-project",
        setup(build) {
          build.onResolve({ filter: /^@typed-sql\// }, async (args) => {
            const [, name, ...parts] = args.path.split("/");
            const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
            const target = manifest.exports[parts.length ? `./${parts.join("/")}` : "."];
            if (typeof target !== "string") throw Error(`Unsupported public runtime export ${args.path}`);
            return { path: resolve(root, "packages", name, target), sideEffects: manifest.sideEffects !== false };
          });
          build.onResolve({ filter: /^project:/ }, (args) => ({ path: args.path.slice(8), namespace: "project" }));
          build.onLoad({ filter: /.*/, namespace: "project" }, (args) => ({
            contents: args.path === "__barrel" ? barrel : modules[args.path],
            loader: "ts",
            resolveDir: root,
          }));
          // All value imports in this subset are grammar/core entrypoints. Type-only local imports erase.
          build.onResolve({ filter: /^\./, namespace: "project" }, (args) => {
            throw Error(`Unexpected project value dependency ${args.path}`);
          });
        },
      },
    ],
  });
  const attribution = {};
  for (const [path, value] of Object.entries(Object.values(result.metafile.outputs)[0].inputs)) {
    if (!value.bytesInOutput) continue;
    if (
      /\/src\/(?:catalog|parser)\//u.test(path) ||
      /(?:pg-contracts|node-api-contracts|odbc-contracts)\.js$/u.test(path)
    )
      throw Error(`Development code leaked into project runtime: ${path}`);
    const group = path.startsWith("project:") ? "application" : (/packages\/([^/]+)\/src/u.exec(path)?.[1] ?? "other");
    attribution[group] = (attribution[group] ?? 0) + value.bytesInOutput;
    if (!path.startsWith("project:") && path !== "<stdin>") inputs.set(path, hash(await readFile(resolve(root, path))));
  }
  const retainedApplicationModules = Object.entries(Object.values(result.metafile.outputs)[0].inputs).filter(
    ([path, value]) => path.startsWith("project:") && path !== "project:__barrel" && value.bytesInOutput > 0,
  ).length;
  return {
    ...sizes(result.outputFiles[0].contents),
    attribution,
    retainedApplicationModules,
    retainedModules: Object.values(result.metafile.outputs)[0].inputs
      ? Object.values(Object.values(result.metafile.outputs)[0].inputs).filter((x) => x.bytesInOutput > 0).length
      : 0,
  };
}
const temporary = await mkdtemp(join(tmpdir(), "typed-sql-project-measurements-"));
try {
  for (const grammar of grammars) {
    const load = (entry) => import(pathToFileURL(join(root, `packages/${grammar}/src/${entry}.ts`)).href);
    const profile = one(await load("profile"), "Profile")();
    const compatibilityDialect = (await load("analysis"))[grammar]();
    const identity = one(await load("contract-profile"), "ContractIdentity")();
    const files = commerceFiles(grammar);
    const parsed = analyzeSqlFiles(grammar, files);
    if (!parsed.snapshot || parsed.problems.some((x) => x.severity === "error"))
      throw Error(`Invalid maintained commerce schema for ${grammar}`);
    const schema = profile.validateSnapshot(parsed.snapshot);
    const manifest = JSON.parse(await readFile(join(root, "packages", grammar, "package.json"), "utf8"));
    const evidence = schema.server?.versionKey ?? schema.version ?? "";
    const coreEntries = Object.keys(manifest.exports)
      .filter((entry) => /^\.\/analysis\/core(?:\/[^/]+)?$/u.test(entry))
      .filter((entry) => {
        const version = entry.slice("./analysis/core".length).replace(/^\//u, "");
        return version === "" || evidence === version || evidence.startsWith(`${version}.`);
      });
    if (coreEntries.length !== 1) throw Error(`Expected one matching core for ${grammar}/${evidence}`);
    const coreEntry = coreEntries[0];
    const dialect = (await load(coreEntry.slice(2)))[grammar]();
    dialect.validateSnapshot(schema);
    const context = {
      grammar: { id: profile.id, version: profile.grammarVersion },
      ...identity,
      schemaHash: calculateSchemaHash(schema),
      typePolicyHash: calculateTypePolicyHash(profile.defaultTypePolicy),
      databaseContextHash: queryContractDigest({ source: "offline-commerce-model", grammar }),
    };
    const coverage = [];
    const base = Object.entries(files)
      .filter(([path]) => path.startsWith("queries/") && /\.(?:ts|sql)$/u.test(path))
      .sort(([a], [b]) => a.localeCompare(b));
    const workloads = [];
    for (const copies of [1, 10, 50]) {
      const contracts = [],
        plans = [],
        plain = {},
        compiled = {};
      let collectedCandidates = 0,
        knownCandidates = 0;
      for (let copy = 0; copy < copies; copy++)
        for (const [file, original] of base) {
          // Copy zero is the unmodified maintained workload. Further copies stress exact-SQL identity.
          const source =
            copy === 0
              ? original
              : file.endsWith(".sql")
                ? `/* workload copy ${copy} */\n${original}`
                : original.replace(/\bsql`/gu, `sql\`/* workload copy ${copy} */`);
          const collection = (file.endsWith(".sql") ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
            source,
            profile,
            schema,
          });
          const compiledSource = file.endsWith(".ts")
            ? compileSource({ source, schema, dialect, runtimeMetadata: true })
            : undefined;
          const analyzed = collection.candidates.map((candidate) => ({
            candidate,
            analysis: dialect.analyze(candidate.sql, schema),
          }));
          const diagnostics = [
            ...collection.diagnostics,
            ...(compiledSource?.diagnostics ?? []),
            ...analyzed.flatMap(({ analysis }) => analysis.diagnostics),
          ];
          const eligible =
            collection.complete && collection.candidates.length > 0 && !diagnostics.some((x) => x.severity === "error");
          const runtimeEligible =
            !!compiledSource &&
            compiledSource.queries.length > 0 &&
            !compiledSource.diagnostics.some((x) => x.severity === "error");
          if (copies === 1 && copy === 0)
            coverage.push({
              file,
              sourceDigest: hash(source),
              completeRendering: collection.complete,
              candidates: collection.candidates.length,
              eligible,
              runtimeTemplateEligible: runtimeEligible,
              runtimeQueryCount: compiledSource?.queries.length ?? 0,
              diagnostics: [...new Set(diagnostics.map((x) => x.code))],
              compatibilityComparison: analyzed.map(({ candidate, analysis }) => {
                const compatibility = compatibilityDialect.analyze(candidate.sql, schema);
                return {
                  sqlDigest: hash(candidate.sql),
                  identicalAnalysis: isDeepStrictEqual(analysis, compatibility),
                  coreDiagnostics: analysis.diagnostics.map(({ code, severity }) => ({ code, severity })),
                  compatibilityDiagnostics: compatibility.diagnostics.map(({ code, severity }) => ({ code, severity })),
                };
              }),
              queryFacts: analyzed.map(({ candidate, analysis }) => {
                const plan = buildQueryValuePlan(
                  dialect,
                  analysis,
                  profile.defaultTypePolicy,
                  candidate.logicalParameterCount,
                );
                return {
                  sqlDigest: hash(candidate.sql),
                  unresolvedCodecDescriptors: [
                    ...plan.columns
                      .filter(unresolvedCodec)
                      .map(({ name, databaseType }) => ({ target: "column", name, databaseType })),
                    ...plan.parameters
                      .filter(unresolvedCodec)
                      .map(({ index, databaseType }) => ({ target: "parameter", index, databaseType })),
                  ],
                };
              }),
            });
          if (runtimeEligible) {
            const name = `${copy}/${file}`;
            plain[name] = source;
            compiled[name] = compiledSource.transformedSource;
          }
          if (!eligible) continue;
          for (const { candidate, analysis } of analyzed) {
            collectedCandidates++;
            const plan = buildQueryValuePlan(
              dialect,
              analysis,
              profile.defaultTypePolicy,
              candidate.logicalParameterCount,
            );
            const unknown = [...plan.columns, ...plan.parameters].filter(unresolvedCodec).length;
            if (!unknown) knownCandidates++;
            contracts.push(
              createQueryContract({
                sql: candidate.sql,
                context,
                origin: "offline-rule",
                valuePlan: plan,
                ...(analysis.semantics?.resultKind ? { resultKind: analysis.semantics.resultKind } : {}),
              }),
            );
            plans.push(plan);
          }
        }
      const directory = join(temporary, `${grammar}-${copies}`);
      await exportQueryContracts(directory, contracts);
      const reopened = await loadQueryContracts(directory);
      const unique = new Set(contracts.map((x) => x.digest)).size;
      if (reopened.length !== unique) throw Error("Export/reopen lost query contracts");
      const artifacts = await filesAt(directory);
      const selected = await bundle(compiled, true);
      if (selected.retainedApplicationModules !== 1)
        throw Error(`Unused project template metadata survived tree shaking for ${grammar}/${copies}`);
      workloads.push({
        copies,
        sourceQueryFiles: base.length * copies,
        collectedCandidates,
        knownCodecCandidates: knownCandidates,
        uniqueContracts: unique,
        runtimeTemplateModules: Object.keys(compiled).length,
        durableFiles: artifacts.length,
        durableFileBytes: artifacts.reduce((n, [, bytes]) => n + bytes.length, 0),
        // Compress a deterministic named-file framing, not a sum of individual compressed sizes.
        durableClosure: sizes(
          Buffer.concat(artifacts.flatMap(([name, bytes]) => [Buffer.from(`${name}\0${bytes.length}\0`), bytes])),
        ),
        valuePlans: sizes(JSON.stringify(plans)),
        rendererOnlyBundle: await bundle(plain),
        withValuePlansBundle: await bundle(compiled),
        selectedModuleThroughBarrel: selected,
      });
    }
    const serialized = JSON.parse(serializeSchemaSnapshot(schema));
    const template = Object.entries(serialized.relations).find(([, relation]) => relation.name === "products");
    if (!template) throw Error("Commerce product relation missing");
    const schemaGrowth = [0, 50, 500].map((extraTables) => {
      const relations = { ...serialized.relations };
      for (let index = 0; index < extraTables; index++) {
        const name = `measurement_products_${index}`;
        relations[template[0].slice(0, -"products".length) + name] = { ...template[1], name };
      }
      const expanded = profile.validateSnapshot(defineSchemaSnapshotV2({ ...serialized, relations }));
      return {
        extraTables,
        totalRelations: Object.keys(expanded.relations).length,
        snapshot: sizes(serializeSchemaSnapshot(expanded)),
      };
    });
    rows.push({
      grammar,
      coreEntry: `@typed-sql/${grammar}${coreEntry.slice(1)}`,
      serverEvidence: evidence,
      schema: sizes(serializeSchemaSnapshot(schema)),
      coverage,
      workloads,
      schemaGrowth,
    });
    console.log(
      JSON.stringify({
        grammar,
        coreEntry,
        identicalCompatibilityCandidates: coverage
          .flatMap((row) => row.compatibilityComparison)
          .filter((row) => row.identicalAnalysis).length,
        files: coverage.length,
        eligible: coverage.filter((x) => x.eligible).length,
        workloads: workloads.map(({ copies, uniqueContracts, withValuePlansBundle }) => ({
          copies,
          uniqueContracts,
          bytes: withValuePlansBundle.bytes,
        })),
      }),
    );
  }
  const report = {
    formatVersion: 1,
    sourceRevision: revision,
    nodeVersion: process.version,
    esbuildVersion: esbuild.version,
    toolDigest: hash(await readFile(fileURLToPath(import.meta.url))),
    lockfileDigest: hash(await readFile(join(root, "pnpm-lock.yaml"))),
    method: {
      corpus:
        "Maintained commerceFiles query modules and DDL for every ledger grammar; schema comes from the same example parser used by the playground, not live introspection.",
      contracts:
        "Actual exported/reopened selected-core offline-rule contracts. Discover the matching public core export using each maintained snapshot's version evidence. No native evidence or qualification is manufactured; this does not measure native acquisition success or latency.",
      comparison:
        "The unmodified base candidates are also analyzed independently through the compatibility analyzer. Record complete analysis equality and both diagnostic lists per exact candidate; this comparison does not qualify native correctness.",
      scaling:
        "Copy 1 is the unmodified commerce workload. Copies 10/50 add SQL comments to create exact-text variants; these are synthetic identity-growth stress tests, not additional application features or production popularity.",
      runtime:
        "All eligible TS query exports retained; SQL assets contribute artifacts but are excluded from both runtime bundle columns. rendererOnlyBundle has original tags; withValuePlansBundle has compiler-injected plans. Neither bundle contains schema snapshots or durable contract envelopes.",
      schemaGrowth:
        "Add 50/500 unused product-shaped relations, validated by each owner. This isolates compiler-input growth from query-plan/runtime growth.",
      compression:
        "gzip level 9; Brotli quality 11; closure compression uses sorted name/NUL/length/NUL/content framing, not a tarball or install size.",
      limitations: [
        "Example DDL snapshots are conservative partial models, not full live catalog snapshots; complete index/constraint/introspection metadata costs are excluded.",
        "Curated application examples are not production telemetry, a usage ranking, or a proof of full SQL coverage.",
        "Inexact/dynamic rendering stays visible and is excluded from exact artifacts; compilable runtime-sized fragments still contribute their selector plans to runtime bundles. Diagnostic template files are excluded from bundles.",
        "Known runtime descriptors do not certify nullability, JSON shape, precision or all semantic facets.",
        "Installation payload and native contract evidence overhead are separate measurements.",
      ],
    },
    corpusDigest: hash(JSON.stringify(grammars.map((grammar) => [grammar, commerceFiles(grammar)]))),
    runtimeInputDigests: Object.fromEntries([...inputs].sort(([a], [b]) => a.localeCompare(b))),
    rows,
  };
  const destination = process.argv[2] ?? join(root, "planning/hybrid-analysis/project-measurements.json");
  const formatted = execFileSync(
    join(root, "node_modules/.bin/biome"),
    ["format", "--stdin-file-path=project-measurements.json"],
    { cwd: root, input: JSON.stringify(report), maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(destination, formatted);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
