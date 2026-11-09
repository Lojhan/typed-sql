import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, factorKeywords, formatGenerated, lockedSource } from "./vocabulary/common.mjs";
import { categories, parsePostgresKeywords } from "./vocabulary/postgres.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const input = join(root, "grammar/postgres/vocabulary");
const output = join(root, "packages/postgres/src/vocabulary/generated");
const pins = JSON.parse(await readFile(join(input, "sources.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "packages/postgres/package.json"), "utf8"));
const majors = Object.keys(manifest.exports)
  .filter((key) => /^\.\/analysis\/core\/\d+$/u.test(key))
  .map((key) => Number(key.split("/").at(-1)))
  .sort((a, b) => a - b);
assert.deepEqual(
  pins.profiles.map(({ major }) => major).sort((a, b) => a - b),
  majors,
  "Every selected core requires a pinned vocabulary profile",
);
assert.equal(pins.formatVersion, 1);
assert.equal(pins.grammar, "postgres");
const format = (name, body) => formatGenerated(root, name, body);
const check = process.argv.includes("--check");
const refresh = process.argv.includes("--refresh");
if (check && refresh) throw Error("Check and explicit source refresh are separate operations");
const lockedFile = (pin) => lockedSource(root, pin);
for (const pin of pins.profiles) {
  assert.ok(Number.isSafeInteger(pin.major));
  assert.match(pin.revision, /^[a-f0-9]{40}$/u);
  for (const [key, path] of [
    ["keywords", "src/include/parser/kwlist.h"],
    ["license", "COPYRIGHT"],
  ]) {
    assert.equal(pin[key].url, `https://raw.githubusercontent.com/postgres/postgres/${pin.revision}/${path}`);
    assert.match(pin[key].digest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(pin[key].bytes) && pin[key].bytes > 0 && pin[key].bytes < 128 * 1024);
  }
}
if (refresh) {
  const profiles = [];
  const notices = new Map();
  for (const pin of pins.profiles) {
    const words = parsePostgresKeywords(await lockedFile(pin.keywords));
    profiles.push({
      major: pin.major,
      version: pin.version,
      sourceDigest: pin.keywords.digest,
      wordsDigest: digest(JSON.stringify(words)),
      words,
    });
    notices.set(pin.license.digest, await lockedFile(pin.license));
  }
  await writeFile(
    join(input, "facts.json"),
    format("facts.json", JSON.stringify({ formatVersion: 1, ...factorKeywords(profiles) })),
  );
  await writeFile(
    join(root, "packages/postgres/POSTGRES_VOCABULARY_NOTICE"),
    `PostgreSQL keyword data source notices\n\n${[...notices.values()].join("\n")}`,
  );
}
const facts = JSON.parse(await readFile(join(input, "facts.json"), "utf8"));
assert.equal(facts.formatVersion, 1);
assert.deepEqual(
  facts.profiles.map(({ major }) => major),
  majors,
);
for (const profile of facts.profiles) {
  const pin = pins.profiles.find(({ major }) => major === profile.major);
  assert.equal(profile.version, pin.version);
  assert.equal(profile.sourceDigest, pin.keywords.digest);
  const rows = [...facts.common, ...profile.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(new Set(rows.map(([name]) => name)).size, rows.length);
  for (const row of rows) {
    assert.equal(row.length, 4);
    assert.match(row[0], /^[a-z_]+$/u);
    assert.ok(categories.includes(row[1]));
    assert.equal(typeof row[2], "boolean");
    assert.match(row[3], /^[A-Z_0-9]+$/u);
  }
  assert.equal(
    digest(JSON.stringify(rows)),
    profile.wordsDigest,
    "Recorded keyword facts changed without source refresh",
  );
}
const files = new Map();
const header =
  "// Generated from hash-locked PostgreSQL kwlist.h declarations; run postgres:vocabulary:refresh.\n// See POSTGRES_VOCABULARY_NOTICE and grammar/postgres/vocabulary/sources.json.\n";
files.set(
  "common.ts",
  header +
    'import type { PostgresKeywordDeclaration } from "../types.js";\n\nexport const commonKeywords = ' +
    JSON.stringify(facts.common) +
    " as const satisfies readonly PostgresKeywordDeclaration[];\n",
);
for (const profile of facts.profiles)
  files.set(
    `${profile.major}.ts`,
    header +
      'import type { PostgresKeywordDeclaration } from "../types.js";\nimport { createPostgresVocabulary } from "../vocabulary.js";\nimport { commonKeywords } from "./common.js";\n\nconst local = ' +
      JSON.stringify(profile.words) +
      " as const satisfies readonly PostgresKeywordDeclaration[];\nexport const vocabulary = createPostgresVocabulary(commonKeywords,local);\n" +
      `export const source = ${JSON.stringify({ version: profile.version, digest: profile.sourceDigest, wordsDigest: profile.wordsDigest })} as const;\n`,
  );
const identityPath = join(root, "packages/postgres/src/vocabulary-identity.ts");
const identity = format(
  "vocabulary-identity.ts",
  header +
    `export const POSTGRES_VOCABULARY_REVISION = ${JSON.stringify(digest(JSON.stringify(facts.profiles.map(({ major, wordsDigest }) => ({ major, wordsDigest })))))};\n`,
);
if (check)
  assert.equal(await readFile(identityPath, "utf8"), identity.toString(), "Regenerate PostgreSQL vocabulary identity");
else await writeFile(identityPath, identity);
await mkdir(output, { recursive: true });
for (const [name, source] of files) {
  const encoded = format(name, source),
    path = join(output, name);
  if (check) assert.equal(await readFile(path, "utf8"), encoded.toString(), `Regenerate PostgreSQL vocabulary ${name}`);
  else await writeFile(path, encoded);
}
console.log(
  `PostgreSQL vocabulary: ${majors.length} profiles; ${facts.common.length} shared rows, ${facts.profiles.reduce((sum, p) => sum + p.words.length, 0)} profile-specific rows`,
);
