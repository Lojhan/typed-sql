import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execute = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../..");
const rootRequire = createRequire(join(workspaceDirectory, "package.json"));
const bridgeRequire = createRequire(join(workspaceDirectory, "packages", "ts-bridge", "package.json"));

await describe("TypeScript 7 compatibility matrix", async () => {
  await it("runs the stable compiler and exact preview bridge versions", async () => {
    const stablePackage = rootRequire.resolve("typescript/package.json");
    const previewPackage = bridgeRequire.resolve("@typed-sql/typescript-preview/package.json");
    const stable = JSON.parse(await readFile(stablePackage, "utf8")) as { readonly version?: string };
    const preview = JSON.parse(await readFile(previewPackage, "utf8")) as { readonly version?: string };
    strict.strictEqual(stable.version, "7.0.2");
    strict.strictEqual(preview.version, "7.1.0-dev.20260824.1");
    const stableOutput = await execute(process.execPath, [join(dirname(stablePackage), "bin", "tsc"), "--version"]);
    const previewOutput = await execute(process.execPath, [join(dirname(previewPackage), "bin", "tsc"), "--version"]);
    strict.strictEqual(stableOutput.stdout.trim(), "Version 7.0.2");
    strict.strictEqual(previewOutput.stdout.trim(), "Version 7.1.0-dev.20260824.1");
  });
});
