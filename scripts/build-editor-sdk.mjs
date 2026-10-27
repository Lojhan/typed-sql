import { execFile as callback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callback);
const root = resolve(import.meta.dirname, "..");
const bridge = JSON.parse(await readFile(join(root, "packages/ts-bridge/package.json"), "utf8"));
const targets = process.argv.includes("--all")
  ? ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]
  : [`${process.platform}-${process.arch}`];
for (const target of targets) {
  const [platform, architecture] = target.split("-");
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(architecture))
    throw new Error(`Unsupported editor SDK target: ${target}`);
  const directory = join(root, "packages/language-server/sdk", target);
  await mkdir(directory, { recursive: true });
  await execFile(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags",
      `-s -w -X main.typescriptVersion=${bridge.typedSql.typescriptPreviewVersion}`,
      "-o",
      join(directory, platform === "win32" ? "tsc.exe" : "tsc"),
      ".",
    ],
    {
      cwd: join(root, "tools/editor-sdk"),
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: platform === "win32" ? "windows" : platform,
        GOARCH: architecture === "x64" ? "amd64" : architecture,
      },
      timeout: 180_000,
    },
  );
  console.log(`Built editor SDK ${target}`);
}

const toolchain = await execFile("go", ["env", "GOROOT"], { cwd: join(root, "tools/editor-sdk") });
const license = join(root, "packages/language-server/sdk/GO-LICENSE.txt");
// Downloaded Go toolchains are read-only. Do not copy that mode into build
// output: a second build must be able to replace the generated license.
await rm(license, { force: true });
await writeFile(license, await readFile(join(toolchain.stdout.trim(), "LICENSE")), { mode: 0o644 });
