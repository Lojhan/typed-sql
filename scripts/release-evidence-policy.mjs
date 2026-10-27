import { readFile } from "node:fs/promises";
import { join } from "node:path";

const uniqueNonEmptyStrings = (value, path) => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  )
    throw new TypeError(`${path} must contain non-empty evidence identifiers`);
  if (new Set(value).size !== value.length) throw new TypeError(`${path} contains duplicate evidence identifiers`);
  return Object.freeze([...value]);
};

export function validateReleaseEvidencePolicy(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Release evidence policy must be an object");
  if (value.formatVersion !== 1) throw new TypeError("Unsupported release evidence policy formatVersion");
  const channelNames = ["development", "beta", "rc", "stable"];
  if (
    Object.keys(value.channels ?? {})
      .sort()
      .join() !== [...channelNames].sort().join()
  )
    throw new TypeError("Release evidence policy must define development, beta, rc, and stable channels");
  const channels = {};
  let previous = new Set();
  for (const name of channelNames) {
    const channel = value.channels[name];
    const required = uniqueNonEmptyStrings(channel?.required, `channels.${name}.required`);
    for (const evidence of previous) {
      if (!required.includes(evidence))
        throw new TypeError(`${name} cannot remove earlier channel evidence ${evidence}`);
    }
    channels[name] = Object.freeze({
      required,
    });
    previous = new Set(required);
  }
  return Object.freeze({
    formatVersion: 1,
    channels: Object.freeze(channels),
  });
}

export async function loadReleaseEvidencePolicy(workspace) {
  return validateReleaseEvidencePolicy(
    JSON.parse(await readFile(join(workspace, "release-evidence-policy.json"), "utf8")),
  );
}
