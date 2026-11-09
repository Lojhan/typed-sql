import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const categories = ["UNRESERVED_KEYWORD", "COL_NAME_KEYWORD", "TYPE_FUNC_NAME_KEYWORD", "RESERVED_KEYWORD"];

/** Parse only the explicit vendor declarations; conditional or unfamiliar records require review. */
export function parsePostgresKeywords(source) {
  const declarations = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  assert.ok(declarations.length, "Missing PostgreSQL keyword declarations");
  const rows = declarations.map((line) => {
    const match = /^\s*PG_KEYWORD\("([a-z_]+)",\s*([A-Z_0-9]+),\s*([A-Z_]+),\s*(BARE_LABEL|AS_LABEL)\)\s*$/u.exec(line);
    assert.ok(match, "Unsupported PostgreSQL keyword declaration");
    assert.ok(categories.includes(match[3]), "Unknown PostgreSQL reservation class");
    return [match[1], match[3], match[4] === "BARE_LABEL", match[2]];
  });
  assert.equal(new Set(rows.map((row) => row[0])).size, rows.length, "Duplicate PostgreSQL keyword");
  return rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function factorKeywords(profiles) {
  const first = profiles[0].words;
  const common = first.filter((row) =>
    profiles.every((profile) => profile.words.some((candidate) => JSON.stringify(candidate) === JSON.stringify(row))),
  );
  const shared = new Set(common.map((row) => row[0]));
  return {
    common,
    profiles: profiles.map(({ words, ...profile }) => ({
      ...profile,
      words: words.filter((row) => !shared.has(row[0])),
    })),
  };
}
