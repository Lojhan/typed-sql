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
    if (channel.stableClaimsAllowed !== (name === "stable"))
      throw new TypeError(`channels.${name}.stableClaimsAllowed is invalid`);
    channels[name] = Object.freeze({
      required,
      stableClaimsAllowed: channel.stableClaimsAllowed,
      ...(channel.minimumSuccessfulCandidates === undefined
        ? {}
        : { minimumSuccessfulCandidates: channel.minimumSuccessfulCandidates }),
    });
    previous = new Set(required);
  }
  if (
    !Number.isSafeInteger(channels.stable.minimumSuccessfulCandidates) ||
    channels.stable.minimumSuccessfulCandidates < 1
  )
    throw new TypeError("Stable releases require at least one successful candidate");
  const promotion = {};
  for (const kind of ["package", "grammar", "editor"]) {
    promotion[kind] = uniqueNonEmptyStrings(value.promotion?.[kind], `promotion.${kind}`);
  }
  return Object.freeze({
    formatVersion: 1,
    channels: Object.freeze(channels),
    promotion: Object.freeze(promotion),
    supportTargetChange: uniqueNonEmptyStrings(value.supportTargetChange, "supportTargetChange"),
  });
}

export async function loadReleaseEvidencePolicy(workspace) {
  return validateReleaseEvidencePolicy(
    JSON.parse(await readFile(join(workspace, "release-evidence-policy.json"), "utf8")),
  );
}
