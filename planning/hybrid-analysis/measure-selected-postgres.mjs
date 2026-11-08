import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = process.cwd();
const {
  build,
  transformSync,
  version: esbuildVersion,
} = createRequire(resolve("packages/build/package.json"))("esbuild");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const digests = {},
  cache = new Map();
const read = (path) => {
  if (!cache.has(path)) cache.set(path, readFileSync(path));
  const value = cache.get(path);
  digests[relative(root, path)] = hash(value);
  return value;
};
const plugin = {
  name: "workspace-sources",
  setup(build) {
    build.onResolve({ filter: /^@typed-sql\// }, (args) => {
      const [, name, ...tail] = args.path.split("/");
      const manifest = JSON.parse(read(resolve("packages", name, "package.json")));
      const target = manifest.exports[tail.length ? `./${tail.join("/")}` : "."];
      const source = /\/src\/(.+)\.js$/u.exec(target);
      if (!source) throw Error(`Unsupported source export ${args.path}`);
      return { path: resolve("packages", name, "src", `${source[1]}.ts`) };
    });
    build.onLoad({ filter: /\.ts$/ }, (args) => ({ contents: read(args.path).toString(), loader: "ts" }));
  },
};
const ledger = JSON.parse(read(resolve("grammar/features/ledger.json")));
const majors = [...ledger.dialects.postgres.stable, ...ledger.dialects.postgres.canary].map(({ minimum, maximum }) => {
  if (minimum !== maximum) throw Error("Expected exact PostgreSQL majors");
  return Number(minimum);
});
// Execute only the generated data module from this pinned, trusted repository revision.
const baselineRevision = "417c1d3020b2655dc798ac220bc8de31fa3a7e08";
const baselineSource = execFileSync(
  "git",
  ["show", `${baselineRevision}:packages/postgres/src/catalog/generated/native.ts`],
  { maxBuffer: 16 * 1024 * 1024 },
);
const baselineModule = transformSync(baselineSource.toString(), { loader: "ts", format: "esm" }).code;
const before = (await import(`data:text/javascript;base64,${Buffer.from(baselineModule).toString("base64")}`))
  .nativeSignatures;
const current = (await import(pathToFileURL(resolve("packages/postgres/src/catalog/generated/native.ts")).href))
  .nativeSignatures;
const parity = majors.map((major) => {
  const baselineDigest = hash(JSON.stringify(before[major])),
    currentDigest = hash(JSON.stringify(current[major]));
  if (baselineDigest !== currentDigest) throw Error(`Native signature parity differs for ${major}`);
  return {
    major,
    signatures: current[major].length,
    names: new Set(current[major].map((row) => row.name)).size,
    baselineDigest,
    currentDigest,
  };
});
const scenarios = {
  runtimeRoot: 'export {sql,renderer,defineQueryValuePlan,withQueryValuePlan} from "@typed-sql/postgres";',
  compatibility: 'export {postgres} from "@typed-sql/postgres/analysis";',
};
for (const major of majors)
  scenarios[`selected${major}`] = `export {postgres} from "@typed-sql/postgres/analysis/profiles/${major}";`;
const rows = [];
for (const [scenario, contents] of Object.entries(scenarios)) {
  const bundled = await build({
    stdin: { contents, resolveDir: root, loader: "ts", sourcefile: `${scenario}.ts` },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    minify: true,
    metafile: true,
    plugins: [plugin],
    legalComments: "none",
  });
  const output = Object.values(bundled.metafile.outputs)[0],
    bytes = bundled.outputFiles[0].contents;
  const catalogInputs = Object.entries(output.inputs)
    .filter(([path, value]) => path.includes("/catalog/") && value.bytesInOutput > 0)
    .map(([path, value]) => ({ path, bytes: value.bytesInOutput }));
  const nativeProfiles = catalogInputs
    .flatMap(({ path }) => {
      const match = /catalog\/generated\/native\/(\d+)\.ts$/u.exec(path);
      return match ? [Number(match[1])] : [];
    })
    .sort((a, b) => a - b);
  const typeProfiles = catalogInputs
    .flatMap(({ path }) => {
      const match = /catalog\/generated\/(\d+)\.ts$/u.exec(path);
      return match ? [Number(match[1])] : [];
    })
    .sort((a, b) => a - b);
  if (scenario.startsWith("selected")) {
    const major = Number(scenario.slice("selected".length));
    if (nativeProfiles.length !== 1 || nativeProfiles[0] !== major)
      throw Error(`Selected bundle includes unrelated native profiles: ${scenario}`);
  }
  rows.push({
    scenario,
    minified: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    nativeProfiles,
    typeProfiles,
    catalogInputs,
  });
}
const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
read(resolve("planning/hybrid-analysis/measure-selected-postgres.mjs"));
const committedInputs = Object.entries(digests).every(([path, expected]) => {
  try {
    return (
      hash(
        execFileSync("git", ["show", `${baseRevision}:${path}`], {
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 16 * 1024 * 1024,
        }),
      ) === expected
    );
  } catch {
    return false;
  }
});
const report = {
  status: committedInputs ? "committed-inputs" : "provisional-worktree-measurement",
  baseRevision,
  baselineRevision,
  baselineSourceDigest: hash(baselineSource),
  tool: { name: "esbuild", version: esbuildVersion, digest: hash(readFileSync(new URL(import.meta.url))) },
  nodeVersion: process.version,
  scope:
    "Exported analyzer factory footprint; shared type/cast registries remain eager. Not an application workload, installation-size reduction, compact-core claim or complete engine inventory.",
  platform: "node",
  target: "es2022",
  gzipLevel: 9,
  brotliQuality: 11,
  parity,
  rows,
  inputDigests: Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b))),
};
const output = resolve("artifacts/grammar-catalog/postgres-selected-bundles.json");
mkdirSync(resolve("artifacts/grammar-catalog"), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, rows: rows.map(({ catalogInputs, ...row }) => row) }, null, 2));
