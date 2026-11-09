import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, factorKeywords, formatGenerated, lockedSource } from "./vocabulary/common.mjs";
import { parseDuckDBVocabulary } from "./vocabulary/duckdb.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  input = join(root, "grammar/duckdb/vocabulary");
const pins = JSON.parse(await readFile(join(input, "sources.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "packages/duckdb/package.json"), "utf8"));
const versions = Object.keys(manifest.exports)
  .filter((key) => /^\.\/analysis\/core\/\d+\.\d+\.\d+$/u.test(key))
  .map((key) => key.split("/").at(-1))
  .sort();
assert.equal(pins.formatVersion, 1);
assert.equal(pins.grammar, "duckdb");
assert.deepEqual(
  pins.profiles.map((profile) => profile.version),
  versions,
  "Every selected DuckDB engine needs pinned evidence",
);
for (const profile of pins.profiles) {
  assert.match(profile.revision, /^[a-f0-9]{40}$/u);
  assert.ok(profile.parser === "yacc" || profile.parser === "peg");
  assert.ok(profile.files.LICENSE);
  for (const [path, pin] of Object.entries(profile.files)) {
    assert.ok(!path.includes(".."));
    assert.equal(pin.url, `https://raw.githubusercontent.com/duckdb/duckdb/${profile.revision}/${path}`);
  }
}
const refresh = process.argv.includes("--refresh"),
  check = process.argv.includes("--check");
assert.ok(!(refresh && check));
const path = join(input, "facts.json"),
  noticePath = join(root, "packages/duckdb/DUCKDB_VOCABULARY_NOTICE");
if (refresh) {
  const profiles = [],
    notices = new Map();
  for (const profile of pins.profiles) {
    const files = Object.fromEntries(
      await Promise.all(
        Object.entries(profile.files).map(async ([name, pin]) => [name, await lockedSource(root, pin)]),
      ),
    );
    const extracted = parseDuckDBVocabulary(files, profile.parser);
    profiles.push({
      version: profile.version,
      parser: profile.parser,
      sourceDigest: digest(JSON.stringify(profile.files)),
      wordsDigest: digest(JSON.stringify(extracted.words)),
      ...extracted,
    });
    for (const [name, body] of Object.entries(files)) if (name.endsWith("LICENSE")) notices.set(digest(body), body);
  }
  const notice = `DuckDB keyword metadata source notices\n\n${pins.profiles.map((profile) => `${profile.version}: https://github.com/duckdb/duckdb/tree/${profile.revision}`).join("\n")}\n\n${[...notices.values()].join("\n")}\n`;
  await writeFile(noticePath, notice);
  const facts = { formatVersion: 1, noticeDigest: digest(notice), ...factorKeywords(profiles) };
  await writeFile(path, formatGenerated(root, "facts.json", JSON.stringify(facts)));
}
const facts = JSON.parse(await readFile(path, "utf8"));
assert.equal(facts.formatVersion, 1);
assert.equal(digest(await readFile(noticePath)), facts.noticeDigest, "DuckDB source notices changed");
assert.deepEqual(
  facts.profiles.map((profile) => profile.version),
  versions,
);
for (const profile of facts.profiles) {
  const pin = pins.profiles.find((pin) => pin.version === profile.version);
  assert.equal(profile.parser, pin.parser);
  assert.equal(profile.sourceDigest, digest(JSON.stringify(pin.files)), "DuckDB pins changed without refreshing facts");
  const words = [...facts.common, ...profile.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(new Set(words.map(([name]) => name)).size, words.length);
  assert.equal(digest(JSON.stringify(words)), profile.wordsDigest);
  assert.ok(
    profile.bareLabels.every((name) => words.some(([word, classes]) => word === name && /[UC]/u.test(classes))),
  );
}
if (check)
  assert.equal(await readFile(path, "utf8"), formatGenerated(root, "facts.json", JSON.stringify(facts)).toString());
const output = join(root, "packages/duckdb/src/vocabulary/generated");
await mkdir(output, { recursive: true });
const header =
  "// Generated from hash-pinned DuckDB declarations; run duckdb:vocabulary:refresh.\n// See DUCKDB_VOCABULARY_NOTICE and grammar/duckdb/vocabulary/sources.json.\n";
const projection = (rows) => rows.map(([name, classes]) => [name, classes]);
const generated = new Map([
  [
    "common.ts",
    header +
      'import type { DuckDBKeywordDeclaration } from "../types.js";\n\nexport const commonKeywords = ' +
      JSON.stringify(projection(facts.common)) +
      " as const satisfies readonly DuckDBKeywordDeclaration[];\n",
  ],
]);
for (const profile of facts.profiles)
  generated.set(
    `${profile.version}.ts`,
    header +
      'import { createDuckDBVocabulary } from "../vocabulary.js";\nimport { commonKeywords } from "./common.js";\n\n' +
      `export const vocabulary = createDuckDBVocabulary(commonKeywords,${JSON.stringify(projection(profile.words))},${JSON.stringify(profile.bareLabels)},${JSON.stringify(profile.specialFunctionHeads)},${JSON.stringify(profile.functionClasses)});\n`,
  );
for (const [name, body] of generated) {
  const target = join(output, name),
    bytes = formatGenerated(root, name, body);
  if (check) assert.equal(await readFile(target, "utf8"), bytes.toString());
  else await writeFile(target, bytes);
}
const identityPath = join(root, "packages/duckdb/src/vocabulary-identity.ts");
const identity = formatGenerated(
  root,
  "vocabulary-identity.ts",
  `${header}export const DUCKDB_VOCABULARY_REVISION = ${JSON.stringify(digest(JSON.stringify(facts)))};\n`,
);
if (check) assert.equal(await readFile(identityPath, "utf8"), identity.toString());
else await writeFile(identityPath, identity);
console.log(
  `DuckDB vocabulary: ${versions.length} profiles; ${facts.common.length} shared rows, ${facts.profiles.reduce((sum, profile) => sum + profile.words.length, 0)} profile-specific rows`,
);
