import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedChannel = process.argv[2];

if (requestedChannel !== "beta" && requestedChannel !== "stable") {
  throw new Error("Usage: node scripts/assert-release-channel.mjs <beta|stable>");
}

const release = JSON.parse(await readFile(join(workspace, "release-manifest.json"), "utf8"));
if (release.channel !== requestedChannel) {
  throw new Error(`Requested ${requestedChannel}, but release-manifest.json declares ${release.channel}`);
}

const manifests = await Promise.all(
  release.packages.map(async (name) => {
    const directory = name.slice("@typed-sql/".length);
    const manifest = JSON.parse(await readFile(join(workspace, "packages", directory, "package.json"), "utf8"));
    if (manifest.name !== name) throw new Error(`${directory}/package.json declares ${manifest.name}`);
    return manifest;
  }),
);

if (requestedChannel === "beta") {
  const pattern = new RegExp(`^${release.series.replaceAll(".", "\\.")}-beta\\.\\d+$`, "u");
  for (const manifest of manifests) {
    if (!pattern.test(manifest.version)) {
      throw new Error(`${manifest.name}@${manifest.version} is not a ${release.series}-beta.N version`);
    }
  }
  if (release.npmTag !== "next") throw new Error("Beta releases must use the next npm tag");
  const pre = JSON.parse(await readFile(join(workspace, ".changeset", "pre.json"), "utf8"));
  if (pre.mode !== "pre" || pre.tag !== "beta") throw new Error("Changesets is not in beta prerelease mode");
} else {
  for (const manifest of manifests) {
    if (manifest.version !== release.series) {
      throw new Error(
        `Stable release must be exactly ${release.series}, received ${manifest.name}@${manifest.version}`,
      );
    }
  }
  if (release.npmTag !== "latest") throw new Error("Stable releases must use the latest npm tag");
  try {
    await access(join(workspace, ".changeset", "pre.json"), constants.F_OK);
    throw new Error("Stable release cannot retain .changeset/pre.json");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

const versions = [...new Set(manifests.map(({ version }) => version))];
process.stdout.write(`Release channel verified: ${requestedChannel} ${versions.join(", ")} -> ${release.npmTag}\n`);
