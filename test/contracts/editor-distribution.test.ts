import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function text(path: string): Promise<string> {
  return readFile(join(workspace, path), "utf8");
}

await describe("external editor distribution", async () => {
  await it("keeps preview-backed editor surfaces explicitly experimental", async () => {
    const languageServer = JSON.parse(await text("packages/language-server/package.json")) as {
      readonly version: string;
      readonly typedSql?: { readonly releaseTrack?: string };
    };
    const vscode = JSON.parse(await text("packages/vscode/package.json")) as {
      readonly private?: boolean;
      readonly version: string;
    };
    strict.match(languageServer.version, /^1\.0\.0-(?:beta|rc)\.\d+$/u);
    strict.strictEqual(languageServer.typedSql?.releaseTrack, "experimental");
    strict.strictEqual(vscode.private, true);
    strict.match(vscode.version, /^0\.1\./u);
    strict.ok((await text("editors/zed/extension.toml")).includes('version = "0.1.0"'));
    strict.ok((await text("editors/zed/Cargo.toml")).includes('version = "0.1.0"'));
  });

  await it("resolves Zed's application-local package before development fallbacks", async () => {
    const source = await text("editors/zed/src/lib.rs");
    const installed = source.indexOf("node_modules/@typed-sql/language-server");
    const path = source.indexOf('worktree.which("typed-sql-language-server")');
    const development = source.indexOf("packages/language-server/dist");
    strict.ok(installed >= 0);
    strict.ok(path > installed);
    strict.ok(development >= 0);
    strict.ok(source.indexOf("join(DEVELOPMENT_SERVER)") > path);
    strict.ok(source.includes("pnpm add -D @typed-sql/language-server@next"));
    strict.ok(!source.includes("/Users/"));
  });

  await it("documents portable startup and the tsserver-free compatibility boundary", async () => {
    const documentation = [
      await text("editors/zed/README.md"),
      await text("packages/language-server/README.md"),
      await text("packages/vscode/README.md"),
      await text("docs/COMPATIBILITY.md"),
    ].join("\n");
    strict.ok(documentation.includes("pnpm add -D @typed-sql/language-server@next"));
    strict.ok(documentation.includes("tsserver.js"));
    strict.ok(documentation.includes("multi-root"));
    strict.ok(documentation.includes("0.1.x"));
    strict.ok(!documentation.includes("/Users/"));
  });

  await it("fails preview startup with actionable context", async () => {
    const server = await text("packages/language-server/src/server.ts");
    strict.ok(server.includes("could not start or communicate with its pinned TypeScript preview process"));
    strict.ok(server.includes("TYPESCRIPT_PREVIEW_VERSION"));
    strict.ok(server.includes("Reinstall @typed-sql/language-server@next"));
    strict.ok(server.includes('preview.once("error"'));
    strict.ok(server.includes('preview.on("exit"'));
    strict.ok(server.includes("nativeRequest"));
  });
});
