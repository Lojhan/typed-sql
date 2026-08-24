import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const preStatePath = fileURLToPath(new URL("../.changeset/pre.json", import.meta.url));
const changesetsCli = fileURLToPath(new URL("../node_modules/@changesets/cli/bin.js", import.meta.url));

export async function withExitedPrereleaseState(path, publish) {
  const original = await readFile(path, "utf8");
  const state = JSON.parse(original);
  if (state.mode !== "pre" || state.tag !== "beta") {
    throw new Error(`Expected Changesets beta prerelease mode, found ${state.mode}:${state.tag}`);
  }

  await writeFile(path, `${JSON.stringify({ ...state, mode: "exit" }, null, 2)}\n`);
  try {
    return await publish();
  } finally {
    await writeFile(path, original);
  }
}

function publishToNext() {
  return new Promise((resolvePublish, rejectPublish) => {
    const child = spawn(process.execPath, [changesetsCli, "publish", "--tag", "next"], {
      cwd: workspace,
      stdio: "inherit",
    });
    child.once("error", rejectPublish);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePublish();
      else rejectPublish(new Error(`Changesets publish failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

export async function main() {
  await withExitedPrereleaseState(preStatePath, publishToNext);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
