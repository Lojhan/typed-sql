import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "packages/build/package.json"));
const esbuild = require("esbuild");
const revision = execFileSync("git", ["rev-parse", process.argv[2] ?? "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blobs = new Map();
const source = (path) => {
  if (!blobs.has(path))
    blobs.set(
      path,
      execFileSync("git", ["show", `${revision}:${path}`], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  return blobs.get(path);
};
const packageTarget = (name, entry) => {
  const manifest = JSON.parse(source(`packages/${name}/package.json`));
  const target = manifest.exports[entry];
  if (typeof target !== "string") throw Error(`Expected explicit export ${name}/${entry}`);
  const tail = /\/src\/(.+)\.js$/u.exec(target)?.[1];
  if (!tail) throw Error(`Unsupported public source target ${target}`);
  return `packages/${name}/src/${tail}.ts`;
};
const sideEffects = (path) => JSON.parse(source(`packages/${path.split("/")[1]}/package.json`)).sideEffects !== false;
const plugin = {
  name: "committed-sources",
  setup(build) {
    build.onResolve({ filter: /^@typed-sql\// }, (args) => {
      const [, name, ...parts] = args.path.split("/");
      const path = packageTarget(name, parts.length ? `./${parts.join("/")}` : ".");
      return { path, namespace: "committed", sideEffects: sideEffects(path) };
    });
    build.onResolve({ filter: /^\.{1,2}\//, namespace: "committed" }, (args) => {
      const target = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
      const candidates = target.endsWith(".js") ? [`${target.slice(0, -3)}.ts`, target] : [target];
      for (const path of candidates) {
        try {
          source(path);
          return { path, namespace: "committed", sideEffects: sideEffects(path) };
        } catch {}
      }
      throw Error(`Missing committed import ${target}`);
    });
    build.onLoad({ filter: /.*/, namespace: "committed" }, (args) => ({
      contents: source(args.path).toString(),
      loader: args.path.endsWith(".json") ? "json" : "ts",
      resolveDir: resolve(root, posix.dirname(args.path)),
    }));
  },
};
const grammars = Object.keys(JSON.parse(source("grammar/features/ledger.json")).dialects).sort();
const rows = [];
for (const grammar of grammars) {
  if (!/^[a-z_]+$/u.test(grammar)) throw Error(`Unsupported builtin grammar identifier ${grammar}`);
  const manifest = JSON.parse(source(`packages/${grammar}/package.json`));
  const profileSource = manifest.exports["./profile"]
    ? source(packageTarget(grammar, "./profile")).toString()
    : undefined;
  const profile = profileSource ? /export function (\w+Profile)\(/u.exec(profileSource)?.[1] : undefined;
  const runtimeSource = source(packageTarget(grammar, "./runtime")).toString();
  const factories = [
    ...new Set(
      [...runtimeSource.matchAll(/\b(create\w+Database)\b/gu)]
        .map((match) => match[1])
        .filter((name) => !name.includes("Routed")),
    ),
  ];
  if ((profileSource && !profile) || factories.length !== 1)
    throw Error(`Ambiguous public entrypoint discovery for ${grammar}`);
  const scenarios = {
    rootTag: `import {sql} from "@typed-sql/${grammar}";export const query=sql\`SELECT 1 AS value\`;`,
    queryTag: `import {sql} from "@typed-sql/${grammar}/query";export const query=sql\`SELECT 1 AS value\`;`,
    execution: `export {${factories[0]} as createDatabase} from "@typed-sql/${grammar}/runtime";export {sql} from "@typed-sql/${grammar}";`,
    analyzer: `export {${grammar} as createDialect} from "@typed-sql/${grammar}${manifest.exports["./analysis"] ? "/analysis" : ""}";`,
    ...(profile
      ? {
          profile: `export {${profile}} from "@typed-sql/${grammar}/profile";`,
          frozenHost: `export {createContractDialect,loadQueryContracts} from "@typed-sql/analysis";export {compileSource} from "@typed-sql/compiler";export {${profile}} from "@typed-sql/${grammar}/profile";`,
        }
      : {}),
    ...Object.fromEntries(
      Object.keys(manifest.exports)
        .filter((entry) => /^\.\/analysis\/(?:core\/)?[^/]+$/u.test(entry))
        .sort()
        .map((entry) => [
          `analyzer:${entry.slice("./analysis/".length).replaceAll("/", ":")}`,
          `export {${grammar} as createDialect} from "@typed-sql/${grammar}${entry.slice(1)}";`,
        ]),
    ),
    ...Object.fromEntries(
      Object.keys(manifest.exports)
        .filter((entry) => /^\.\/analysis\/core\/[^/]+$/u.test(entry))
        .sort()
        .flatMap((entry) => {
          const version = entry.slice("./analysis/core/".length);
          const pack = `./analysis/packs/${version}/compatibility`;
          return manifest.exports[pack]
            ? [
                [
                  `analyzer:core:${version}:compatibility`,
                  `import {${grammar} as dialect} from "@typed-sql/${grammar}${entry.slice(1)}";import {${grammar}CompatibilityPack as pack} from "@typed-sql/${grammar}${pack.slice(1)}";export const createDialect=(options={})=>dialect({...options,packs:[pack]});`,
                ],
              ]
            : [];
        }),
    ),
  };
  for (const [scenario, contents] of Object.entries(scenarios)) {
    const output = await esbuild.build({
      stdin: { contents, resolveDir: root, sourcefile: `measurement-${grammar}-${scenario}.ts`, loader: "ts" },
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
      plugins: [plugin],
      external: ["pg", "mysql2", "mysql2/*", "koffi", "odbc", "msnodesqlv8", "@duckdb/node-api", "@duckdb/node-api/*"],
    });
    const bytes = output.outputFiles[0].contents;
    const inputs = Object.entries(Object.values(output.metafile.outputs)[0].inputs).filter(
      ([, item]) => item.bytesInOutput > 0,
    );
    const attribution = {};
    const catalogs = [];
    let generatedBytes = 0;
    for (const [input, value] of inputs) {
      const path = input.replace(/^committed:/u, "");
      const parts = path.split("/");
      const group =
        parts[0] === "packages"
          ? `${parts[1]}${path.includes("/src/catalog/") ? "/catalog" : path.includes("/src/parser/") ? "/parser" : "/other"}`
          : "external/entry";
      attribution[group] = (attribution[group] ?? 0) + value.bytesInOutput;
      if (path.includes("/src/catalog/")) catalogs.push(path);
      if (input.startsWith("committed:") && /^\/\/ Generated (?:by|from) /u.test(source(path).toString()))
        generatedBytes += value.bytesInOutput;
    }
    if (["rootTag", "queryTag", "profile", "frozenHost"].includes(scenario) && catalogs.length)
      throw Error(`Global grammar catalogs leaked into ${grammar}/${scenario}: ${catalogs.join(",")}`);
    const row = {
      grammar,
      scenario,
      minifiedBytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 9 }).length,
      brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
      generatedInputBytes: generatedBytes,
      globalCatalogInputs: catalogs,
      attribution,
      outputDigest: hash(bytes),
    };
    rows.push(row);
    console.log(
      JSON.stringify({
        grammar,
        scenario,
        minifiedBytes: row.minifiedBytes,
        gzipBytes: row.gzipBytes,
        globalCatalogInputs: catalogs.length,
      }),
    );
  }
}
const toolDigest = hash(await readFile(fileURLToPath(import.meta.url)));
const baseline = process.argv[4] ? JSON.parse(await readFile(process.argv[4], "utf8")) : undefined;
if (
  baseline &&
  (baseline.measurementToolDigest !== toolDigest ||
    baseline.esbuildVersion !== esbuild.version ||
    baseline.nodeVersion !== process.version)
)
  throw Error("Baseline must use the same measurement tool, Node and esbuild versions");
const report = {
  formatVersion: 2,
  sourceRevision: revision,
  nodeVersion: process.version,
  esbuildVersion: esbuild.version,
  measurementToolDigest: toolDigest,
  ...(baseline
    ? {
        comparisonBaseline: {
          sourceRevision: baseline.sourceRevision,
          lockfileDigest: baseline.lockfileDigest,
          reportDigest: hash(await readFile(process.argv[4])),
          rows: baseline.rows.map(
            ({ grammar, scenario, minifiedBytes, gzipBytes, brotliBytes, generatedInputBytes, outputDigest }) => ({
              grammar,
              scenario,
              minifiedBytes,
              gzipBytes,
              brotliBytes,
              generatedInputBytes,
              outputDigest,
            }),
          ),
        },
      }
    : {}),
  lockfileDigest: hash(source("pnpm-lock.yaml")),
  method: {
    source: "Git blobs at sourceRevision; public exports resolve to their committed source files",
    format: "esm",
    platform: "node",
    target: "es2022",
    treeShaking: true,
    minify: true,
    gzipLevel: 9,
    brotliQuality: 11,
    generatedAttribution: "Files with an explicit Generated by/from header; uncompressed esbuild bytesInOutput",
    attribution: "Uncompressed minified input groups; compression applies to whole outputs only",
    limitations: [
      "Synthetic public entrypoints, not a representative project corpus or installation-size measurement.",
      "Frozen host exports contract/compile helpers and a profile; it contains no project contracts or native acquisition.",
      "External driver binaries and engine distributions are excluded.",
    ],
  },
  rows,
  inputDigests: Object.fromEntries(
    [...blobs].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, hash(bytes)]),
  ),
};
const formatted = execFileSync(
  resolve(root, "node_modules/.bin/biome"),
  ["format", "--stdin-file-path=planning/hybrid-analysis/bundle-measurements.json"],
  {
    cwd: root,
    input: `${JSON.stringify(report, null, 2)}\n`,
    maxBuffer: 16 * 1024 * 1024,
  },
);
await writeFile(process.argv[3] ?? new URL("bundle-measurements.json", import.meta.url), formatted);
