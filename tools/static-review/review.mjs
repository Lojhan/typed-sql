import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import parser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { parseToolReport, sourceEntries } from "./inputs.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const output = join(root, "artifacts/static-review");

async function binary(base, name, command) {
  const manifestPath = join(base, "node_modules", name, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return join(dirname(manifestPath), typeof manifest.bin === "string" ? manifest.bin : manifest.bin[command]);
}

async function main() {
  const workspaces = {};
  const sourceRoots = [];
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspace = `packages/${entry.name}`;
    const manifest = JSON.parse(await readFile(join(root, workspace, "package.json"), "utf8"));
    workspaces[workspace] = {
      entry: [...sourceEntries(manifest), "test/**/*.test.ts"],
      project: ["src/**/*.ts", "test/**/*.ts"],
    };
    sourceRoots.push(`${workspace}/src`);
  }
  if (sourceRoots.length === 0) throw new Error("No package source directories found");
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        ignores: ["**/generated/**", "**/dist/**", "**/node_modules/**"],
      },
      {
        files: ["packages/*/src/**/*.ts"],
        languageOptions: { parser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } },
        rules: {
          complexity: ["warn", { max: 20, variant: "classic" }],
          "no-constant-condition": "error",
          "no-unreachable": "error",
          "no-unsafe-finally": "error",
          "no-async-promise-executor": "error",
          "no-promise-executor-return": "error",
          "no-sparse-arrays": "error",
        },
      },
    ],
  });
  const complexity = await eslint.lintFiles(sourceRoots.map((path) => `${path}/**/*.ts`));
  if (complexity.length === 0) throw new Error("ESLint scanned no files");
  const eslintReport = complexity.map(({ filePath, messages, errorCount, warningCount, fatalErrorCount }) => ({
    file: relative(root, filePath),
    messages,
    errorCount,
    warningCount,
    fatalErrorCount,
  }));
  const biome = parseToolReport(
    "biome",
    spawnSync(
      process.execPath,
      [
        await binary(root, "@biomejs/biome", "biome"),
        "lint",
        ...sourceRoots,
        "--only",
        "complexity/noExcessiveCognitiveComplexity",
        "--only",
        "performance/noAccumulatingSpread",
        "--only",
        "performance/useTopLevelRegex",
        "--reporter=json",
        "--max-diagnostics=none",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  await mkdir(output, { recursive: true });
  const configPath = join(output, "knip.json");
  await writeFile(configPath, `${JSON.stringify({ workspaces }, null, 2)}\n`);
  const knip = parseToolReport(
    "knip",
    spawnSync(
      process.execPath,
      [
        await binary(directory, "knip", "knip"),
        "--config",
        configPath,
        "--workspace",
        "./packages/*",
        "--include",
        "exports,types,files",
        "--reporter",
        "json",
        "--no-progress",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const summary = {
    node: process.version,
    tools: {
      eslint: ESLint.version,
      parser: JSON.parse(await readFile(join(directory, "node_modules/@typescript-eslint/parser/package.json"), "utf8"))
        .version,
      knip: JSON.parse(await readFile(join(directory, "node_modules/knip/package.json"), "utf8")).version,
      biome: JSON.parse(await readFile(join(root, "node_modules/@biomejs/biome/package.json"), "utf8")).version,
    },
    packageCount: sourceRoots.length,
    eslintFiles: complexity.length,
    cyclomaticAbove20: complexity.reduce(
      (total, file) => total + file.messages.filter((m) => m.ruleId === "complexity").length,
      0,
    ),
    eslintErrors: complexity.reduce((total, file) => total + file.errorCount, 0),
    biomeByRule: biome.diagnostics.reduce((totals, diagnostic) => {
      totals[diagnostic.category] = (totals[diagnostic.category] ?? 0) + 1;
      return totals;
    }, {}),
    knipFilesWithFindings: knip.issues.length,
    advisory: true,
  };
  for (const [name, report] of Object.entries({ eslint: eslintReport, biome, knip, summary }))
    await writeFile(join(output, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Reports: ${output}`);
  if (summary.eslintErrors > 0 || biome.summary.errors > 0) process.exitCode = 1;
}
await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
