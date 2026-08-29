import { strict as assert } from "node:assert";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const workspace = resolve(import.meta.dirname, "..");
const vsix = resolve(workspace, process.argv[2] ?? "artifacts/typed-sql-vscode.vsix");
const wasm = resolve(workspace, process.argv[3] ?? "artifacts/typed-sql-zed.wasm");

const listing = (await execFile("unzip", ["-Z1", vsix])).stdout.split("\n");
for (const expected of [
  "extension/package.json",
  "extension/readme.md",
  "extension/LICENSE.txt",
  "extension/bundle/extension.cjs",
]) {
  assert.ok(listing.includes(expected), `VSIX is missing ${expected}`);
}
const bundle = (await execFile("unzip", ["-p", vsix, "extension/bundle/extension.cjs"])).stdout;
assert.match(bundle, /typedSql\/status/u);
assert.match(bundle, /@typed-sql[\\/]language-server/u);
assert.doesNotMatch(bundle, /NativePreviewTypeScriptBridge|function analyzeSource/u);
assert.doesNotMatch(bundle, /\/Users\/|\/home\/runner\//u);

const wasmBytes = await readFile(wasm);
assert.deepEqual([...wasmBytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
assert.ok((await stat(wasm)).size > 1_024, "Zed artifact is unexpectedly small");

console.log("typed-sql editor artifacts are portable and use the shared language server");
