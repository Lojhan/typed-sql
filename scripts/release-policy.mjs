import { readFile } from "node:fs/promises";
import { join } from "node:path";

const packageNamePattern = /^@typed-sql\/[a-z][a-z0-9-]*$/u;
const seriesPattern = /^\d+\.\d+\.\d+$/u;

function stringArray(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string array`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${label} must not contain duplicates`);
  for (const name of value) {
    if (!packageNamePattern.test(name)) throw new TypeError(`${label} contains an invalid package name: ${name}`);
  }
  return value;
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

export function validateReleaseManifest(value) {
  if (typeof value !== "object" || value === null) throw new TypeError("release-manifest.json must be an object");
  const manifest = value;
  if (manifest.channel !== "beta" && manifest.channel !== "stable") {
    throw new TypeError("release-manifest.json channel must be beta or stable");
  }
  if (typeof manifest.series !== "string" || !seriesPattern.test(manifest.series)) {
    throw new TypeError("release-manifest.json series must be a stable X.Y.Z version");
  }
  const expectedTag = manifest.channel === "stable" ? "latest" : "next";
  if (manifest.npmTag !== expectedTag) {
    throw new TypeError(`${manifest.channel} releases must use the ${expectedTag} npm tag`);
  }
  if (typeof manifest.packagePolicy !== "object" || manifest.packagePolicy === null) {
    throw new TypeError("release-manifest.json must declare packagePolicy");
  }
  const packages = stringArray(manifest.packages, "release-manifest.json packages");
  const stable = stringArray(manifest.packagePolicy.stable, "release-manifest.json packagePolicy.stable");
  const experimental = stringArray(
    manifest.packagePolicy.experimental,
    "release-manifest.json packagePolicy.experimental",
    true,
  );
  const overlap = stable.filter((name) => experimental.includes(name));
  if (overlap.length > 0) throw new TypeError(`Release tracks overlap: ${overlap.join(", ")}`);
  const expectedPackages = manifest.channel === "stable" ? stable : [...stable, ...experimental];
  if (!sameMembers(packages, expectedPackages)) {
    throw new TypeError(
      `${manifest.channel} release packages must match the ${manifest.channel === "stable" ? "stable" : "complete beta"} package policy`,
    );
  }
  return {
    channel: manifest.channel,
    series: manifest.series,
    npmTag: manifest.npmTag,
    packages,
    packagePolicy: { stable, experimental },
  };
}

export async function loadReleaseManifest(workspace) {
  return validateReleaseManifest(JSON.parse(await readFile(join(workspace, "release-manifest.json"), "utf8")));
}
