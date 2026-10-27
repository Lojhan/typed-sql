const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const { basename, delimiter, dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 11)) throw new Error("Node.js >=22.11 is required");
  const root = resolve(process.argv[1]);
  const fallback = process.argv[2];
  process.chdir(root);
  let installed = false;
  for (let directory = root; ; directory = dirname(directory)) {
    if (existsSync(join(directory, "node_modules/@typed-sql/language-server/package.json"))) {
      installed = true;
      break;
    }
    if (dirname(directory) === directory) break;
  }
  let server;
  if (installed) {
    const entry = createRequire(join(root, "package.json")).resolve("@typed-sql/language-server");
    server = join(dirname(entry), "server.js");
    if (!existsSync(server)) throw new Error("Installed language server is incomplete");
  } else {
    if (fallback) {
      const name = basename(fallback).toLowerCase();
      if (
        !["typed-sql-language-server", "typed-sql-language-server.cmd", "typed-sql-language-server.exe"].includes(name)
      )
        throw new Error("Unexpected PATH language-server executable");
      // Resolve only the fixed public command. The discovered directory is passed
      // as PATH data, never interpolated into shell syntax (including on Windows).
      const child = spawn(
        process.platform === "win32" ? "cmd.exe" : "typed-sql-language-server",
        process.platform === "win32" ? ["/d", "/v:off", "/s", "/c", "typed-sql-language-server --stdio"] : ["--stdio"],
        {
          cwd: root,
          stdio: "inherit",
          env: { ...process.env, PATH: `${dirname(fallback)}${delimiter}${process.env.PATH ?? ""}` },
        },
      );
      child.once("error", () => process.exit(1));
      child.once("exit", (code) => process.exit(code ?? 1));
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
      return;
    }
    if (existsSync(join(root, "packages/language-server/package.json")))
      server = join(root, "packages/language-server/dist/packages/language-server/src/server.js");
    else throw new Error("Language server not found; run pnpm add -D @typed-sql/language-server");
  }
  process.argv = [process.execPath, server, "--stdio"];
  await import(pathToFileURL(server).href);
}

main().catch((error) => {
  process.stderr.write(`typed-sql Zed launcher: ${error.message}\n`);
  process.exitCode = 1;
});
