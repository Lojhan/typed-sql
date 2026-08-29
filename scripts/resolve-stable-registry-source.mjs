import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPublishedOnNpm, loadReleasePlan } from "./publish-prerelease.mjs";

const defaultWorkspace = fileURLToPath(new URL("..", import.meta.url));

export async function resolveStableRegistrySource(options = {}) {
  const workspace = options.workspace ?? defaultWorkspace;
  const plan = options.plan ?? (await loadReleasePlan("stable", workspace));
  const isPublished = options.isPublished ?? isPublishedOnNpm;

  for (const pkg of plan.packages) {
    if (!(await isPublished(pkg.name, pkg.version))) {
      return { tag: "next", expected: undefined };
    }
  }

  return { tag: "latest", expected: "workspace" };
}

export async function main() {
  const source = await resolveStableRegistrySource();
  process.stdout.write(`tag=${source.tag}\nexpected=${source.expected ?? ""}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
