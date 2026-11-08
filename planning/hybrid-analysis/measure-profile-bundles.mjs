import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = process.cwd(),
  require = createRequire(resolve("packages/build/package.json")),
  esbuild = require("esbuild");
const digests = {},
  sourceCache = new Map();
const hash = (data) => createHash("sha256").update(data).digest("hex");
const read = (path) => {
  if (!sourceCache.has(path)) sourceCache.set(path, readFileSync(path));
  const b = sourceCache.get(path);
  digests[relative(root, path)] = hash(b);
  return b;
};
const plugin = {
  name: "workspace-sources",
  setup(build) {
    build.onResolve({ filter: /^@typed-sql\// }, (args) => {
      const [, name, ...tail] = args.path.split("/");
      const pkg = JSON.parse(read(resolve("packages", name, "package.json")));
      const out = pkg.exports[tail.length ? `./${tail.join("/")}` : "."];
      const sub = /\/src\/(.+)\.js$/.exec(out);
      if (!sub) throw Error(out);
      return { path: resolve("packages", name, "src", `${sub[1]}.ts`) };
    });
    build.onLoad({ filter: /\.ts$/ }, (args) => ({ contents: read(args.path).toString(), loader: "ts" }));
  },
};
const rows = [];
for (const [scenario, contents] of Object.entries({
  tag: 'export {sql,renderer,defineQueryValuePlan,withQueryValuePlan} from "@typed-sql/postgres/tag";',
  profile: 'export {postgresProfile} from "@typed-sql/postgres/profile";',
  frozenHost:
    'export {createContractDialect,loadQueryContracts} from "@typed-sql/analysis"; export {compileSource} from "@typed-sql/compiler"; export {postgresProfile} from "@typed-sql/postgres/profile";',
})) {
  const built = await esbuild.build({
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
  const out = Object.values(built.metafile.outputs)[0],
    b = built.outputFiles[0].contents;
  const catalogs = Object.entries(out.inputs)
    .filter(([p, v]) => p.includes("/catalog/") && v.bytesInOutput > 0)
    .map(([path, v]) => ({ path, bytes: v.bytesInOutput }));
  rows.push({
    scenario,
    minified: b.length,
    gzip: gzipSync(b, { level: 9 }).length,
    brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    globalCatalogInputs: catalogs,
  });
}
const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const committedInputs = Object.entries(digests).every(([path, expected]) => {
  try {
    return (
      hash(
        execFileSync("git", ["show", `${baseRevision}:${path}`], {
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 64 * 1024 * 1024,
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
  tool: esbuild.version,
  toolDigest: hash(readFileSync(new URL(import.meta.url))),
  nodeVersion: process.version,
  gzipLevel: 9,
  brotliQuality: 11,
  platform: "node",
  target: "es2022",
  rows,
  inputDigests: digests,
};
mkdirSync("artifacts/grammar-catalog", { recursive: true });
writeFileSync("artifacts/grammar-catalog/postgres-profile-bundles.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(rows, null, 2));
