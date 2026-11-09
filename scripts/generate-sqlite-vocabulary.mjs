import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLITE_LANGUAGE_SUPPORT } from "../packages/sqlite/src/support.ts";
import { digest } from "./vocabulary/postgres.mjs";
import { parseSqliteVocabulary } from "./vocabulary/sqlite.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const input = join(root, "grammar/sqlite/vocabulary");
const pins = JSON.parse(await readFile(join(input, "sources.json"), "utf8"));
assert.equal(pins.formatVersion, 1);
assert.equal(pins.grammar, "sqlite");
const versions = pins.profiles.map(({ version }) => version);
assert.equal(new Set(versions).size, versions.length);
assert.deepEqual(
  versions,
  [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
);
const minimum = SQLITE_LANGUAGE_SUPPORT.minimum.split(".").map(Number);
const maximum = SQLITE_LANGUAGE_SUPPORT.maximum.split(".").map(Number);
assert.equal(minimum[0], maximum[0]);
for (let minor = minimum[1]; minor <= maximum[1]; minor++)
  assert.ok(versions.includes(`${minimum[0]}.${minor}.0`), "Every supported SQLite minor needs source evidence");
assert.ok(versions.includes(SQLITE_LANGUAGE_SUPPORT.maximum));
const paths = ["tool/mkkeywordhash.c", "src/parse.y", "src/tokenize.c", "LICENSE.md", "VERSION"];
for (const profile of pins.profiles) {
  assert.match(profile.revision, /^[a-f0-9]{40}$/u);
  assert.deepEqual(Object.keys(profile.files).sort(), [...paths].sort());
  for (const path of paths) {
    const pin = profile.files[path];
    assert.equal(pin.url, `https://raw.githubusercontent.com/sqlite/sqlite/${profile.revision}/${path}`);
    assert.match(pin.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes < 256 * 1024);
  }
}
const check = process.argv.includes("--check"),
  refresh = process.argv.includes("--refresh");
assert.ok(!(check && refresh));
const format = (name, body) =>
  execFileSync(join(root, "node_modules/.bin/biome"), ["format", `--stdin-file-path=${name}`], {
    cwd: root,
    input: body,
  });
async function lockedFile(pin) {
  const path = join(root, "node_modules/.cache/typed-sql-vocabulary", pin.digest.slice(7));
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, pin.bytes);
    assert.equal(digest(bytes), pin.digest);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  assert.equal(bytes.length, pin.bytes);
  assert.equal(digest(bytes), pin.digest);
  return bytes.toString("utf8");
}
if (refresh) {
  const complete = [],
    notices = new Map();
  for (const profile of pins.profiles) {
    const files = Object.fromEntries(
      await Promise.all(paths.map(async (path) => [path, await lockedFile(profile.files[path])])),
    );
    assert.equal(files.VERSION.trim(), profile.version);
    const facts = parseSqliteVocabulary(files[paths[0]], files[paths[1]], files[paths[2]]);
    complete.push({ version: profile.version, sourceDigest: digest(JSON.stringify(profile.files)), ...facts });
    notices.set(profile.files["LICENSE.md"].digest, files["LICENSE.md"]);
  }
  const common = complete[0].words.filter((row) =>
    complete.every((profile) => profile.words.some((candidate) => JSON.stringify(candidate) === JSON.stringify(row))),
  );
  const shared = new Set(common.map(([name]) => name)),
    packs = {},
    profiles = [];
  for (const profile of complete) {
    const wordsDigest = digest(JSON.stringify(profile.words));
    const facts = { words: profile.words.filter(([name]) => !shared.has(name)), masks: profile.masks };
    const pack = digest(JSON.stringify(facts));
    packs[pack] = facts;
    profiles.push({ version: profile.version, sourceDigest: profile.sourceDigest, wordsDigest, pack });
  }
  await writeFile(
    join(input, "facts.json"),
    format("facts.json", JSON.stringify({ formatVersion: 1, common, packs, profiles })),
  );
  await writeFile(
    join(root, "packages/sqlite/SQLITE_VOCABULARY_NOTICE"),
    `SQLite keyword and grammar source notices\n\n${[...notices.values()].join("\n")}`,
  );
}
const noticeHeader = Buffer.from("SQLite keyword and grammar source notices\n\n");
const notice = await readFile(join(root, "packages/sqlite/SQLITE_VOCABULARY_NOTICE"));
assert.ok(notice.subarray(0, noticeHeader.length).equals(noticeHeader));
let noticeOffset = noticeHeader.length;
const licenses = new Map(
  pins.profiles.map((profile) => [profile.files["LICENSE.md"].digest, profile.files["LICENSE.md"]]),
);
for (const [hash, pin] of licenses) {
  assert.equal(digest(notice.subarray(noticeOffset, noticeOffset + pin.bytes)), hash, "SQLite source notice changed");
  noticeOffset += pin.bytes;
  if (noticeOffset < notice.length) {
    assert.equal(notice[noticeOffset], 10);
    noticeOffset++;
  }
}
assert.equal(noticeOffset, notice.length);
const facts = JSON.parse(await readFile(join(input, "facts.json"), "utf8"));
assert.equal(facts.formatVersion, 1);
assert.deepEqual(
  facts.profiles.map(({ version }) => version),
  versions,
);
for (const profile of facts.profiles) {
  const pin = pins.profiles.find((pin) => pin.version === profile.version);
  assert.equal(
    profile.sourceDigest,
    digest(JSON.stringify(pin.files)),
    "SQLite source pins changed without refreshing facts",
  );
  const pack = facts.packs[profile.pack];
  assert.equal(digest(JSON.stringify(pack)), profile.pack);
  const words = [...facts.common, ...pack.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(new Set(words.map(([name]) => name)).size, words.length);
  assert.equal(digest(JSON.stringify(words)), profile.wordsDigest);
}
const header =
  "// Generated from hash-locked SQLite keyword, grammar and tokenizer declarations.\n// Run sqlite:vocabulary:refresh; see SQLITE_VOCABULARY_NOTICE and grammar/sqlite/vocabulary/sources.json.\n";
const source =
  header +
  'import type { SqliteKeywordDeclaration, SqliteKeywordMasks } from "../types.js";\nimport { createSqliteVocabulary } from "../vocabulary.js";\n\nconst common = ' +
  JSON.stringify(facts.common) +
  " as const satisfies readonly SqliteKeywordDeclaration[];\n" +
  Object.entries(facts.packs)
    .map(
      ([_id, pack], i) =>
        `const pack${i} = createSqliteVocabulary(common,${JSON.stringify(pack.words)} as const satisfies readonly SqliteKeywordDeclaration[],${JSON.stringify(pack.masks)} as const satisfies SqliteKeywordMasks);\n`,
    )
    .join("") +
  "export const profiles = [" +
  facts.profiles
    .map((p) => `[${JSON.stringify(p.version)},pack${Object.keys(facts.packs).indexOf(p.pack)}]`)
    .join(",") +
  "] as const;\n";
const identity = `${header}export const SQLITE_VOCABULARY_REVISION = ${JSON.stringify(digest(JSON.stringify(facts)))};\n`;
for (const [name, text] of [
  ["vocabulary/generated/profiles.ts", source],
  ["vocabulary-identity.ts", identity],
]) {
  const path = join(root, "packages/sqlite/src", name),
    bytes = format(name, text);
  if (check) assert.equal(await readFile(path, "utf8"), bytes.toString(), `Regenerate SQLite ${name}`);
  else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}
console.log(
  `SQLite vocabulary: ${versions.length} profiles; ${facts.common.length} shared rows, ${Object.keys(facts.packs).length} distinct delta packs`,
);
