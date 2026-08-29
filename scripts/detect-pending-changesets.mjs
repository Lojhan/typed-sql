import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultWorkspace = fileURLToPath(new URL("..", import.meta.url));

async function prereleaseState(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "pre.json"), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function detectPendingChangesets(workspace = defaultWorkspace) {
  const directory = join(resolve(workspace), ".changeset");
  const identifiers = (await readdir(directory))
    .filter((entry) => entry.endsWith(".md") && entry !== "README.md")
    .map((entry) => entry.slice(0, -".md".length))
    .sort();
  const pre = await prereleaseState(directory);
  if (pre === undefined) return identifiers;
  if (pre.mode === "exit") return ["prerelease-exit"];
  if (pre.mode !== "pre") throw new TypeError(".changeset/pre.json is not a valid prerelease state");
  if (pre.changesets === undefined) return identifiers;
  if (!Array.isArray(pre.changesets) || pre.changesets.some((id) => typeof id !== "string"))
    throw new TypeError(".changeset/pre.json has an invalid legacy changesets list");
  const consumed = new Set(pre.changesets);
  return identifiers.filter((identifier) => !consumed.has(identifier));
}

export async function main() {
  const pending = await detectPendingChangesets();
  process.stdout.write(`present=${pending.length > 0}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
