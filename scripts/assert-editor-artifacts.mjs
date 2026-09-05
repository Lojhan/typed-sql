import { strict as assert } from "node:assert";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const workspace = resolve(import.meta.dirname, "..");
const vsix = resolve(workspace, process.argv[2] ?? "artifacts/typed-sql-vscode.vsix");
const wasm = resolve(workspace, process.argv[3] ?? "artifacts/typed-sql-zed.wasm");
const reportFile = resolve(workspace, process.argv[4] ?? "artifacts/editor-artifacts.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const unzip = async (path) => (await execFile("unzip", ["-p", vsix, path], { maxBuffer: 4 * 1024 * 1024 })).stdout;

const listing = (await execFile("unzip", ["-Z1", vsix])).stdout.split("\n");
for (const expected of [
  "extension/package.json",
  "extension/readme.md",
  "extension/LICENSE.txt",
  "extension/bundle/extension.cjs",
]) {
  assert.ok(listing.includes(expected), `VSIX is missing ${expected}`);
}
assert.ok(
  listing.every((path) => !path.startsWith("extension/src/")),
  "VSIX must not contain extension source",
);
assert.ok(
  listing.every((path) => !path.includes("node_modules")),
  "VSIX must not contain unpacked dependencies",
);
assert.ok(
  listing.every((path) => !path.endsWith(".map")),
  "VSIX must not contain source maps",
);

const manifest = JSON.parse(await unzip("extension/package.json"));
assert.equal(manifest.main, "./bundle/extension.cjs");
assert.deepEqual(manifest.extensionKind, ["workspace"]);
assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, false);
assert.ok(manifest.capabilities.untrustedWorkspaces.description.length > 0);
assert.equal(manifest.capabilities.virtualWorkspaces, false);
assert.ok(
  listing.every((path) => !path.startsWith("extension/test/")),
  "VSIX must not ship host-test fixtures",
);
assert.deepEqual(manifest.activationEvents, [
  "onLanguage:typescript",
  "onLanguage:typescriptreact",
  "onCommand:typedSql.showBridgeStatus",
]);
assert.ok(manifest.engines?.vscode, "VSIX must declare its VS Code engine");
assert.ok(
  manifest.contributes?.commands?.some(({ command }) => command === "typedSql.showBridgeStatus"),
  "VSIX must contribute its status command",
);
const settings = manifest.contributes?.configuration?.properties ?? {};
assert.deepEqual(
  Object.keys(settings).sort(),
  [
    "typedSql.analysisDebounceMs",
    "typedSql.configPath",
    "typedSql.maxCacheEntries",
    "typedSql.maxWorkspaceFiles",
    "typedSql.nativePreview",
    "typedSql.projectFile",
    "typedSql.schemaPath",
    "typedSql.serverPath",
  ].sort(),
);
assert.equal(settings["typedSql.nativePreview"]?.default, true);
assert.equal(settings["typedSql.analysisDebounceMs"]?.default, 20);

const bundle = await unzip("extension/bundle/extension.cjs");
assert.match(bundle, /typedSql\/status/u);
assert.match(bundle, /@typed-sql[\\/]language-server/u);
assert.match(bundle, /analysis-identity/u);
assert.match(bundle, /diagnostic-fixes/u);
assert.match(bundle, /createFileSystemWatcher/u);
assert.match(bundle, /typed-sql\.config\.\*,schema\.json/u);
assert.match(bundle, /onDidChangeConfiguration/u);
assert.match(bundle, /restartClients/u);
assert.doesNotMatch(bundle, /NativePreviewTypeScriptBridge|function analyzeSource/u);
assert.doesNotMatch(bundle, /\/Users\/|\/home\/runner\//u);

const wasmBytes = await readFile(wasm);
assert.deepEqual([...wasmBytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
assert.ok((await stat(wasm)).size > 1_024, "Zed artifact is unexpectedly small");
const wasmText = wasmBytes.toString("latin1");
for (const expected of [
  "node_modules/@typed-sql/language-server/package.json",
  "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js",
  "typed-sql-language-server",
  "packages/language-server/dist/packages/language-server/src/server.js",
  "analysis-identity",
  "diagnostic-fixes",
  "status",
]) {
  assert.ok(wasmText.includes(expected), `Zed WASM is missing ${expected}`);
}
assert.ok(!wasmText.includes("/Users/"), "Zed WASM contains a local absolute path");

const extensionToml = await readFile(resolve(workspace, "editors/zed/extension.toml"), "utf8");
const cargoToml = await readFile(resolve(workspace, "editors/zed/Cargo.toml"), "utf8");
const extensionVersion = /^version = "([^"]+)"$/mu.exec(extensionToml)?.[1];
const cargoVersion = /^version = "([^"]+)"$/mu.exec(cargoToml)?.[1];
assert.equal(extensionVersion, cargoVersion, "Zed manifest and crate versions must match");
assert.match(extensionToml, /languages = \["TypeScript", "TSX"\]/u);

const vsixBytes = await readFile(vsix);
await writeFile(
  reportFile,
  `${JSON.stringify(
    {
      formatVersion: 1,
      vscode: {
        version: manifest.version,
        engine: manifest.engines.vscode,
        sha256: sha256(vsixBytes),
        size: vsixBytes.length,
        files: listing.filter(Boolean).length,
      },
      zed: {
        version: extensionVersion,
        api: /^zed_extension_api = "([^"]+)"$/mu.exec(cargoToml)?.[1],
        sha256: sha256(wasmBytes),
        size: wasmBytes.length,
      },
    },
    null,
    2,
  )}\n`,
);

console.log("typed-sql editor artifacts are portable and use the shared language server");
