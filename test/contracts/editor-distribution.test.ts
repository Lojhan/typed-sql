import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await describe("editor package boundaries", async () => {
  const manifest = JSON.parse(await readFile(join(workspace, "editors/vscode/package.json"), "utf8"));

  await it("publishes the confirmed extension ID as a thin workspace client", () => {
    strict.strictEqual(manifest.repository.directory, "editors/vscode");
    strict.strictEqual(`${manifest.publisher}.${manifest.name}`, "lojhan.typed-sql");
    strict.strictEqual(manifest.private, true);
    strict.match(manifest.version, /^0\.\d+\.\d+$/u);
    strict.deepStrictEqual(manifest.extensionKind, ["workspace"]);
    strict.deepStrictEqual(Object.keys(manifest.dependencies), ["vscode-languageclient"]);
  });

  await it("requires trust and filesystem access and keeps settings folder-scoped", () => {
    strict.strictEqual(manifest.capabilities.untrustedWorkspaces.supported, false);
    strict.strictEqual(manifest.capabilities.virtualWorkspaces, false);
    for (const setting of Object.values(manifest.contributes.configuration.properties)) {
      strict.strictEqual((setting as { scope: string }).scope, "resource");
    }
  });
});
