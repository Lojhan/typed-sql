import assert from "node:assert/strict";
import { digest } from "./common.mjs";

/** Reviewed native deltas keep external parser declarations distinct from engine permissions. */
export function sqlServerNativePermissions(facts, qualification, major, compatibilityLevel) {
  assert.equal(qualification.formatVersion, 1);
  const source = facts.profiles.find((profile) => profile.major === major);
  const profile = qualification.profiles.find(
    (profile) => profile.major === major && profile.compatibilityLevel === compatibilityLevel,
  );
  assert.ok(source?.compatibilityLevels.includes(compatibilityLevel) && profile, "Missing native vocabulary scope");
  assert.equal(profile.sourceDigest, source.sourceDigest, "Stale native vocabulary source");
  assert.equal(profile.wordsDigest, source.wordsDigest, "Stale native vocabulary words");
  const words = [...facts.common, ...source.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const permissions = new Map(words.map(([word, token]) => [word, token === null ? 255 : 64]));
  const seen = new Set();
  for (const [word, mask] of [...qualification.common, ...profile.overrides]) {
    assert.ok(permissions.has(word) && !seen.has(word), "Unknown or duplicate native word override");
    assert.ok(
      Number.isSafeInteger(mask) && mask >= 0 && mask <= 255 && (mask & 64) === 64,
      "Incomplete native word permission",
    );
    seen.add(word);
    permissions.set(word, mask);
  }
  assert.equal(
    digest(JSON.stringify([...permissions])),
    profile.permissionsDigest,
    "Native permissions changed without reconciliation",
  );
  return permissions;
}
