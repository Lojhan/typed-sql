import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, formatGenerated, lockedSource } from "./vocabulary/common.mjs";
import { mySqlDescriptorTypes } from "./vocabulary/mysql-descriptors.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  directory = join(root, "grammar/mysql/qualification");
const sources = JSON.parse(await readFile(join(root, "grammar/mysql/vocabulary/sources.json"), "utf8"));
const selected = (profile) => ({ lex: profile.files["sql/lex.h"], grammar: profile.files["sql/sql_yacc.yy"] });
for (const profile of sources.profiles) {
  assert.match(profile.revision, /^[a-f0-9]{40}$/u);
  for (const path of ["sql/lex.h", "sql/sql_yacc.yy"])
    assert.equal(
      profile.files[path].url,
      `https://raw.githubusercontent.com/mysql/mysql-server/${profile.revision}/${path}`,
    );
}
const target = join(directory, "descriptor-types.json"),
  refresh = process.argv.includes("--refresh");
assert.ok(!(refresh && process.argv.includes("--check")));
if (refresh) {
  const profiles = [],
    inventories = {};
  for (const profile of sources.profiles) {
    const pins = selected(profile);
    const [lex, grammar] = await Promise.all([lockedSource(root, pins.lex), lockedSource(root, pins.grammar)]);
    const facts = mySqlDescriptorTypes(lex, grammar);
    const factsDigest = digest(JSON.stringify(facts));
    inventories[factsDigest] = facts;
    profiles.push({
      version: profile.version,
      sourceDigest: digest(JSON.stringify(pins)),
      factsDigest,
    });
  }
  await mkdir(directory, { recursive: true });
  await writeFile(
    target,
    formatGenerated(root, "descriptor-types.json", JSON.stringify({ formatVersion: 1, inventories, profiles })),
  );
}
const facts = JSON.parse(await readFile(target, "utf8"));
assert.equal(facts.formatVersion, 1);
assert.equal(facts.profiles.length, sources.profiles.length);
for (const [index, profile] of facts.profiles.entries()) {
  const { version, sourceDigest, factsDigest } = profile;
  const data = facts.inventories[factsDigest];
  assert.equal(version, sources.profiles[index].version);
  assert.equal(sourceDigest, digest(JSON.stringify(selected(sources.profiles[index]))));
  assert.equal(factsDigest, digest(JSON.stringify(data)));
  assert.deepEqual(
    [...new Set(data.cases.flatMap(({ alternatives }) => alternatives))].sort(),
    data.alternatives.map(({ id }) => id).sort(),
  );
  assert.equal(new Set(data.cases.map(({ kind, type }) => `${kind}:${type}`)).size, data.cases.length);
}
assert.deepEqual(
  Object.keys(facts.inventories).sort(),
  [...new Set(facts.profiles.map(({ factsDigest }) => factsDigest))].sort(),
);
