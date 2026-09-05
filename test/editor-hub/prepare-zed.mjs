import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grammarCases } from "./cases.mjs";
import { buildMatrix } from "./matrix.mjs";
import { prepareWorkspace } from "./workspace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = join(root, "artifacts/editor-hub");
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(join(artifacts, "zed-"));
const workspaces = [];
for (const spec of grammarCases) {
  const directory = join(run, spec.id);
  const settings = await prepareWorkspace(directory, root, spec);
  await mkdir(join(directory, ".zed"), { recursive: true });
  await writeFile(
    join(directory, ".zed/settings.json"),
    JSON.stringify(
      {
        languages: { TypeScript: { language_servers: ["typed-sql"] }, TSX: { language_servers: ["typed-sql"] } },
        lsp: {
          "typed-sql": {
            binary: {
              path: process.execPath,
              arguments: [
                join(root, "packages/language-server/dist/packages/language-server/src/server.js"),
                "--stdio",
              ],
            },
            settings,
          },
        },
      },
      null,
      2,
    ),
  );
  workspaces.push({ grammar: spec.id, directory, file: join(directory, "query.ts") });
}
await writeFile(
  join(run, "manifest.json"),
  JSON.stringify(
    {
      status: "prepared-only",
      extension: join(root, "editors/zed"),
      workspaces,
      warning:
        "No Zed process launched and no host assertion executed. Install the dev extension into an isolated profile before host validation.",
    },
    null,
    2,
  ),
);
await writeFile(join(run, "matrix.json"), JSON.stringify(buildMatrix([]), null, 2));
console.log(`Prepared shared Zed fixtures (not host evidence): ${run}`);
