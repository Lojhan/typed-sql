import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, formatGenerated, lockedSource } from "./vocabulary/common.mjs";
import { parseSqliteStandardTypes } from "./vocabulary/sqlite-descriptors.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  directory = join(root, "grammar/sqlite/qualification"),
  sources = JSON.parse(await readFile(join(directory, "descriptor-sources.json"), "utf8")),
  vocabulary = JSON.parse(await readFile(join(root, "grammar/sqlite/vocabulary/sources.json"), "utf8"));
const refresh = process.argv.includes("--refresh");
assert.ok(!(refresh && process.argv.includes("--check")));
assert.equal(sources.formatVersion, 1);
assert.deepEqual(
  sources.profiles.map(({ version }) => version),
  vocabulary.profiles.map(({ version }) => version),
);
for (const [index, profile] of sources.profiles.entries()) {
  assert.equal(profile.revision, vocabulary.profiles[index].revision);
  assert.match(profile.revision, /^[a-f0-9]{40}$/u);
  assert.equal(profile.source.url, `https://raw.githubusercontent.com/sqlite/sqlite/${profile.revision}/src/global.c`);
  assert.match(profile.source.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(
    Number.isSafeInteger(profile.source.bytes) && profile.source.bytes > 0 && profile.source.bytes < 128 * 1024,
  );
}
const target = join(directory, "descriptor-types.json");
if (refresh) {
  const inventories = {},
    profiles = [];
  for (const profile of sources.profiles) {
    const types = parseSqliteStandardTypes(await lockedSource(root, profile.source));
    const identity = digest(JSON.stringify(types));
    inventories[identity] = types;
    profiles.push([profile.version, digest(JSON.stringify(profile)), identity]);
  }
  await writeFile(
    target,
    formatGenerated(root, "descriptor-types.json", JSON.stringify({ formatVersion: 1, inventories, profiles })),
  );
}
const facts = JSON.parse(await readFile(target, "utf8"));
assert.equal(facts.formatVersion, 1);
assert.equal(facts.profiles.length, sources.profiles.length);
for (const [index, [version, sourceDigest, inventoryDigest]] of facts.profiles.entries()) {
  assert.equal(version, sources.profiles[index].version);
  assert.equal(sourceDigest, digest(JSON.stringify(sources.profiles[index])));
  const types = facts.inventories[inventoryDigest];
  assert.ok(Array.isArray(types) && types.length > 0);
  assert.equal(inventoryDigest, digest(JSON.stringify(types)));
  assert.equal(new Set(types.map(({ name }) => name)).size, types.length);
  for (const type of types) {
    assert.match(type.name, /^[A-Z][A-Z0-9_]*$/u);
    assert.match(type.affinity, /^[A-Z]+$/u);
  }
}
assert.deepEqual(
  Object.keys(facts.inventories).sort(),
  [...new Set(facts.profiles.map((profile) => profile[2]))].sort(),
);
