import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDirectory = join(workspace, "packages");
const packages = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

await Promise.all([
  ...packages.map((packageName) => rm(join(packagesDirectory, packageName, "dist"), { recursive: true, force: true })),
  rm(join(packagesDirectory, "vscode", "bundle"), { recursive: true, force: true }),
]);
