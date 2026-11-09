import assert from "node:assert/strict";
import { digest } from "./common.mjs";
import { sqlServerVocabularyCases } from "./sqlserver-probes.mjs";

/** Validate complete native scope coverage before producing reviewable policy deltas. */
export function reconcileSqlServerVocabulary({ facts, reports, sourceRevision, run, producerDigest }) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(run, /^[1-9][0-9]*$/u);
  assert.match(producerDigest, /^sha256:[a-f0-9]{64}$/u);
  const contexts = sqlServerVocabularyCases([["ordinary", null]]).map((item) => item.role);
  const expectedPairs = facts.profiles
    .flatMap((profile) => profile.compatibilityLevels.map((level) => `${profile.major}/${level}`))
    .sort();
  const profiles = [],
    artifacts = [],
    seen = new Set();
  for (const { file, bytes } of reports) {
    assert.ok(bytes.byteLength < 32 * 1024 * 1024);
    const artifact = JSON.parse(bytes);
    const source = facts.profiles.find((profile) => profile.major === artifact.major);
    assert.ok(source, "Unknown native engine profile");
    assert.equal(file, `catalog-${source.major}.json`);
    artifacts.push({ major: source.major, file: file, digest: digest(bytes) });
    assert.equal(artifact.profiles.length, source.compatibilityLevels.length, "Incomplete native compatibility matrix");
    const words = [...facts.common, ...source.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const profile of artifact.profiles) {
      const native = profile.vocabulary;
      assert.ok(native && ["matched", "source-mismatch"].includes(native.status), "Native vocabulary is unavailable");
      const key = `${source.major}/${profile.compatibilityLevel}`;
      assert.ok(expectedPairs.includes(key) && !seen.has(key), "Unknown or duplicate native scope");
      seen.add(key);
      assert.equal(profile.server.version, artifact.expectedBuild);
      assert.equal(Number(profile.server.compatibility_level), profile.compatibilityLevel);
      assert.equal(Number(profile.server.version.split(".")[0]), source.major);
      assert.equal(native.major, source.major);
      assert.equal(native.compatibilityLevel, profile.compatibilityLevel);
      assert.equal(native.sourceDigest, source.sourceDigest);
      assert.equal(native.wordsDigest, source.wordsDigest);
      assert.equal(native.toolDigest, producerDigest, "Native producer must match its committed source");
      assert.deepEqual(native.contexts, contexts);
      assert.equal(native.declarations, words.length);
      assert.equal(native.probes, words.length * contexts.length);
      assert.deepEqual(
        native.permissions.map(([word]) => word),
        words.map(([word]) => word),
      );
      const overrides = [];
      for (let i = 0; i < words.length; i++) {
        const [word, token] = words[i],
          [name, mask] = native.permissions[i];
        assert.equal(name, word);
        assert.ok(
          Number.isSafeInteger(mask) && mask >= 0 && mask <= 255 && (mask & 64) === 64,
          "Incomplete native identifier permissions",
        );
        if (mask !== (token === null ? 255 : 64)) overrides.push([word, mask]);
      }
      profiles.push({
        major: source.major,
        compatibilityLevel: profile.compatibilityLevel,
        serverVersion: profile.server.version,
        sourceDigest: source.sourceDigest,
        wordsDigest: source.wordsDigest,
        permissionsDigest: digest(JSON.stringify(native.permissions)),
        overrides,
      });
    }
  }
  assert.deepEqual([...seen].sort(), expectedPairs, "Every supported native scope requires evidence");
  profiles.sort((a, b) => a.major - b.major || a.compatibilityLevel - b.compatibilityLevel);
  artifacts.sort((a, b) => a.major - b.major);
  const common = profiles[0].overrides.filter((entry) =>
    profiles.every((profile) => profile.overrides.some((other) => JSON.stringify(other) === JSON.stringify(entry))),
  );
  for (const profile of profiles)
    profile.overrides = profile.overrides.filter(([name]) => !common.some(([word]) => word === name));
  const qualification = {
    formatVersion: 1,
    scope: "Native identifier context observations; no function/result semantics are inferred",
    sourceRevision,
    run: `https://github.com/Lojhan/typed-sql/actions/runs/${run}`,
    producerDigest: producerDigest,
    artifacts,
    contexts,
    common,
    profiles,
  };
  return qualification;
}
