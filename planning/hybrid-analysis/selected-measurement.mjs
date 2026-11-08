import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Shared provenance and bundle settings for selected-analyzer measurements. */
export function selectedMeasurement(scriptUrl) {
  const root = process.cwd();
  const {
    build,
    transformSync,
    version: esbuildVersion,
  } = createRequire(resolve("packages/build/package.json"))("esbuild");
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  const digests = {},
    cache = new Map();
  const read = (input) => {
    const path = input instanceof URL ? fileURLToPath(input) : input;
    if (!cache.has(path)) cache.set(path, readFileSync(path));
    const value = cache.get(path);
    digests[relative(root, path)] = hash(value);
    return value;
  };
  const gitSource = (revision, path) =>
    execFileSync("git", ["show", `${revision}:${path}`], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
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
  read(new URL(import.meta.url));
  read(new URL(scriptUrl));
  return {
    read,
    hash,
    gitSource,
    transformSync,
    async bundle(scenario, contents) {
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
      return {
        scenario,
        minified: bytes.length,
        gzip: gzipSync(bytes, { level: 9 }).length,
        brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
        catalogInputs: Object.entries(output.inputs)
          .filter(([path, value]) => path.includes("/catalog/") && value.bytesInOutput > 0)
          .map(([path, value]) => ({ path, bytes: value.bytesInOutput })),
      };
    },
    finish(output, details, rows) {
      const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const committedInputs = Object.entries(digests).every(([path, expected]) => {
        try {
          return hash(gitSource(baseRevision, path)) === expected;
        } catch {
          return false;
        }
      });
      const report = {
        status: committedInputs ? "committed-inputs" : "provisional-worktree-measurement",
        baseRevision,
        ...details,
        tool: { name: "esbuild", version: esbuildVersion, digest: hash(readFileSync(new URL(scriptUrl))) },
        nodeVersion: process.version,
        platform: "node",
        target: "es2022",
        gzipLevel: 9,
        brotliQuality: 11,
        rows,
        inputDigests: Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b))),
      };
      mkdirSync(resolve("artifacts/grammar-catalog"), { recursive: true });
      writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        JSON.stringify({ status: report.status, rows: rows.map(({ catalogInputs, ...row }) => row) }, null, 2),
      );
    },
  };
}
