import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLSERVER_LANGUAGE_SUPPORT } from "../packages/sqlserver/src/support.ts";
import { digest, factorKeywords, formatGenerated, lockedSource } from "./vocabulary/common.mjs";
import { parseSqlServerVocabulary } from "./vocabulary/sqlserver.mjs";
import { sqlServerNativePermissions } from "./vocabulary/sqlserver-policy.mjs";
import { sqlServerVocabularyCases } from "./vocabulary/sqlserver-probes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  input = join(root, "grammar/sqlserver/vocabulary");
const pins = JSON.parse(await readFile(join(input, "sources.json"), "utf8"));
assert.equal(pins.formatVersion, 1);
assert.equal(pins.grammar, "sqlserver");
assert.equal(pins.repository, "microsoft/SqlScriptDOM");
assert.match(pins.revision, /^[a-f0-9]{40}$/u);
assert.deepEqual(
  pins.profiles.map((profile) => profile.major),
  SQLSERVER_LANGUAGE_SUPPORT.engineMajors,
);
for (const profile of pins.profiles) {
  assert.deepEqual(
    profile.compatibilityLevels,
    SQLSERVER_LANGUAGE_SUPPORT.compatibilityLevels.filter((level) => level <= profile.major * 10),
  );
  assert.equal(profile.parser, `SqlScriptDom/Parser/TSql/TSql${profile.major}0.g`);
}
assert.deepEqual(pins.shared, [
  "LICENSE",
  "SqlScriptDom/Parser/TSql/TSqlTokenTypes.g",
  "SqlScriptDom/Parser/TSql/CodeGenerationSupporter.cs",
]);
assert.deepEqual(
  Object.keys(pins.files).sort(),
  [...pins.shared, ...pins.profiles.map((profile) => profile.parser)].sort(),
);
for (const [path, pin] of Object.entries(pins.files))
  assert.equal(pin.url, `https://raw.githubusercontent.com/microsoft/SqlScriptDOM/${pins.revision}/${path}`);
const refresh = process.argv.includes("--refresh"),
  check = process.argv.includes("--check");
assert.ok(!(refresh && check));
const target = join(input, "facts.json"),
  noticePath = join(root, "packages/sqlserver/SQLSERVER_VOCABULARY_NOTICE");
if (refresh) {
  const files = Object.fromEntries(
    await Promise.all(
      Object.entries(pins.files).map(async ([path, pin]) => [path, await lockedSource(root, pin, 2 * 1024 * 1024)]),
    ),
  );
  const profiles = [];
  let nonWords;
  for (const profile of pins.profiles) {
    const parsed = parseSqlServerVocabulary(
      files[pins.shared[1]],
      files[profile.parser],
      files[pins.shared[2]],
      profile.major,
    );
    if (nonWords !== undefined) assert.deepEqual(parsed.nonWords, nonWords);
    nonWords = parsed.nonWords;
    profiles.push({
      major: profile.major,
      compatibilityLevels: profile.compatibilityLevels,
      sourceDigest: digest(JSON.stringify([...pins.shared, profile.parser].map((path) => pins.files[path]))),
      wordsDigest: digest(JSON.stringify(parsed.words)),
      words: parsed.words,
    });
  }
  const notice = `SQL Server vocabulary source notices\n\nSource: https://github.com/microsoft/SqlScriptDOM/tree/${pins.revision}\n\n${files.LICENSE}`;
  await writeFile(noticePath, notice);
  await writeFile(
    target,
    formatGenerated(
      root,
      "facts.json",
      JSON.stringify({ formatVersion: 1, noticeDigest: digest(notice), nonWords, ...factorKeywords(profiles) }),
    ),
  );
}
const facts = JSON.parse(await readFile(target, "utf8"));
assert.equal(facts.formatVersion, 1);
assert.equal(digest(await readFile(noticePath)), facts.noticeDigest);
assert.deepEqual(
  facts.profiles.map((profile) => profile.major),
  SQLSERVER_LANGUAGE_SUPPORT.engineMajors,
);
for (const profile of facts.profiles) {
  const pin = pins.profiles.find((pin) => pin.major === profile.major);
  assert.deepEqual(profile.compatibilityLevels, pin.compatibilityLevels);
  assert.equal(
    profile.sourceDigest,
    digest(JSON.stringify([...pins.shared, pin.parser].map((path) => pins.files[path]))),
  );
  const words = [...facts.common, ...profile.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(new Set(words.map(([name]) => name)).size, words.length);
  assert.equal(digest(JSON.stringify(words)), profile.wordsDigest);
}
if (check)
  assert.equal(await readFile(target, "utf8"), formatGenerated(root, "facts.json", JSON.stringify(facts)).toString());
const qualification = JSON.parse(await readFile(join(input, "qualification.json"), "utf8"));
assert.deepEqual(
  qualification.contexts,
  sqlServerVocabularyCases([["ordinary", null]]).map((item) => item.role),
);
assert.deepEqual(
  qualification.profiles.map((profile) => `${profile.major}/${profile.compatibilityLevel}`),
  facts.profiles.flatMap((profile) => profile.compatibilityLevels.map((level) => `${profile.major}/${level}`)),
);
for (const profile of qualification.profiles)
  sqlServerNativePermissions(facts, qualification, profile.major, profile.compatibilityLevel);
console.log(
  `SQL Server source vocabulary: ${facts.profiles.length} engine profiles, ${facts.profiles.reduce((sum, profile) => sum + profile.compatibilityLevels.length, 0)} compatibility contexts; ${facts.common.length} shared words, ${facts.profiles.reduce((sum, profile) => sum + profile.words.length, 0)} profile-specific rows. Source declarations require native qualification.`,
);
