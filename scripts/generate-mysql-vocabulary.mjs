import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MySqlKeywordFlags as Flags } from "../packages/mysql/src/vocabulary/flags.ts";
import { digest, factorKeywords, formatGenerated, lockedSource } from "./vocabulary/common.mjs";
import { parseMySqlVocabulary } from "./vocabulary/mysql.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  input = join(root, "grammar/mysql/vocabulary"),
  output = join(root, "packages/mysql/src/vocabulary/generated");
const pins = JSON.parse(await readFile(join(input, "sources.json"), "utf8")),
  manifest = JSON.parse(await readFile(join(root, "packages/mysql/package.json"), "utf8"));
const series = Object.keys(manifest.exports)
  .filter((key) => /^\.\/analysis\/core\/\d+\.\d+$/u.test(key))
  .map((key) => key.split("/").at(-1))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
assert.equal(pins.formatVersion, 1);
assert.equal(pins.grammar, "mysql");
assert.deepEqual(
  pins.profiles.map((profile) => profile.series),
  series,
  "Every selected MySQL series needs source evidence",
);
const paths = [
  "sql/lex.h",
  "sql/lex_symbol.h",
  "sql/sql_yacc.yy",
  "sql/gen_keyword_list.cc",
  "LICENSE",
  "sql/item_create.cc",
];
for (const profile of pins.profiles) {
  assert.equal(profile.version.split(".").slice(0, 2).join("."), profile.series);
  assert.match(profile.revision, /^[a-f0-9]{40}$/u);
  assert.deepEqual(Object.keys(profile.files).sort(), [...paths].sort());
  for (const path of paths)
    assert.equal(
      profile.files[path].url,
      `https://raw.githubusercontent.com/mysql/mysql-server/${profile.revision}/${path}`,
    );
}
const project = (rows) =>
  rows.map(([name, , reserved, group, functionHead, bareFunction, ordinaryFunction, infix]) => [
    name,
    (reserved ? Flags.reserved : 0) |
      (group === "function" ? Flags.specialFunction : group === "hintable" ? Flags.hintable : 0) |
      (functionHead ? Flags.functionHead : 0) |
      (bareFunction ? Flags.bareFunction : 0) |
      (ordinaryFunction ? Flags.ordinaryFunction : 0) |
      (infix ? Flags.infix : 0),
  ]);
const refresh = process.argv.includes("--refresh"),
  check = process.argv.includes("--check");
assert.ok(!(refresh && check));
const format = (name, body) => formatGenerated(root, name, body);
const noticePath = join(root, "packages/mysql/MYSQL_VOCABULARY_NOTICE");
if (refresh) {
  const profiles = [],
    notices = new Map();
  for (const profile of pins.profiles) {
    const files = Object.fromEntries(
      await Promise.all(paths.map(async (path) => [path, await lockedSource(root, profile.files[path])])),
    );
    const facts = parseMySqlVocabulary(files[paths[0]], files[paths[2]], files[paths[3]], files[paths[5]]);
    profiles.push({
      series: profile.series,
      version: profile.version,
      sourceDigest: digest(JSON.stringify(profile.files)),
      wordsDigest: digest(JSON.stringify(facts.words)),
      hints: facts.hints,
      words: facts.words,
    });
    for (const path of [paths[0], paths[2], paths[3], paths[5]]) {
      const header = /\/\*[\s\S]*?\*\//u.exec(files[path]);
      assert.ok(
        header?.[0].includes("Copyright") && header[0].includes("GNU General Public License"),
        "Missing MySQL source attribution",
      );
      notices.set(digest(header[0]), header[0]);
    }
    const license =
      /GNU GENERAL PUBLIC LICENSE[\s\S]*?the GNU Lesser General Public License instead of this License\./u.exec(
        files.LICENSE,
      );
    assert.ok(license, "Unrecognized source license layout");
    notices.set(digest(license[0]), license[0]);
  }
  const notice = `MySQL keyword metadata source notices\n\nSource declarations and reservation/lexical facts: ${pins.profiles.map((p) => `${p.version} (${p.files["sql/lex.h"].url})`).join("; ")}\n\n${[...notices.values()].join("\n\n")}\n`;
  await writeFile(noticePath, notice);
  await writeFile(
    join(input, "facts.json"),
    format(
      "facts.json",
      JSON.stringify({ formatVersion: 1, noticeDigest: digest(notice), ...factorKeywords(profiles) }),
    ),
  );
}
const facts = JSON.parse(await readFile(join(input, "facts.json"), "utf8"));
assert.equal(facts.formatVersion, 1);
assert.equal(digest(await readFile(noticePath)), facts.noticeDigest, "MySQL source notices changed");
assert.deepEqual(
  facts.profiles.map((profile) => profile.series),
  series,
);
for (const profile of facts.profiles) {
  const pin = pins.profiles.find((pin) => pin.series === profile.series);
  assert.equal(pin.version, profile.version);
  assert.equal(
    digest(JSON.stringify(pin.files)),
    profile.sourceDigest,
    "MySQL source pins changed without refreshing facts",
  );
  const words = [...facts.common, ...profile.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(new Set(words.map(([name]) => name)).size, words.length);
  assert.equal(digest(JSON.stringify(words)), profile.wordsDigest);
}
await mkdir(output, { recursive: true });
const header =
  "// Generated from hash-locked MySQL lexical and grammar declarations; run mysql:vocabulary:refresh.\n// See MYSQL_VOCABULARY_NOTICE and grammar/mysql/vocabulary/sources.json.\n";
const files = new Map([
  [
    "common.ts",
    header +
      'import type { MySqlKeywordDeclaration } from "../types.js";\n\nexport const commonKeywords = ' +
      JSON.stringify(project(facts.common)) +
      " as const satisfies readonly MySqlKeywordDeclaration[];\n",
  ],
]);
for (const profile of facts.profiles)
  files.set(
    `${profile.series}.ts`,
    header +
      'import type { MySqlKeywordDeclaration } from "../types.js";\nimport { createMySqlVocabulary } from "../vocabulary.js";\nimport { commonKeywords } from "./common.js";\n\nconst local = ' +
      JSON.stringify(project(profile.words)) +
      " as const satisfies readonly MySqlKeywordDeclaration[];\nexport const vocabulary = createMySqlVocabulary(commonKeywords,local);\n" +
      `export const source = ${JSON.stringify({ version: profile.version, digest: profile.sourceDigest })} as const;\n`,
  );
for (const [name, body] of files) {
  const path = join(output, name),
    bytes = format(name, body);
  if (check) assert.equal(await readFile(path, "utf8"), bytes.toString());
  else await writeFile(path, bytes);
}
const identityPath = join(root, "packages/mysql/src/vocabulary-identity.ts"),
  identity = format(
    "vocabulary-identity.ts",
    `${header}export const MYSQL_VOCABULARY_REVISION = ${JSON.stringify(digest(JSON.stringify(facts)))};\n`,
  );
if (check) assert.equal(await readFile(identityPath, "utf8"), identity.toString());
else await writeFile(identityPath, identity);
console.log(
  `MySQL vocabulary: ${series.length} profiles; ${facts.common.length} shared rows, ${facts.profiles.reduce((sum, p) => sum + p.words.length, 0)} profile-specific rows`,
);
