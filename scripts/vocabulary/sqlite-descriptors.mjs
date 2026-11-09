import assert from "node:assert/strict";

/** Read all three independent source tables; do not copy SQLite's standard-name list. */
export function parseSqliteStandardTypes(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  const table = (name) => {
    const declarations = [...text.matchAll(new RegExp(`\\b${name}\\s*\\[\\s*\\]\\s*=\\s*\\{([^}]+)\\}\\s*;`, "gu"))];
    assert.equal(declarations.length, 1, `Expected one complete ${name} declaration`);
    return declarations[0][1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  };
  const names = table("sqlite3StdType"),
    lengths = table("sqlite3StdTypeLen"),
    affinities = table("sqlite3StdTypeAffinity");
  assert.ok(names.length > 0 && names.length < 100);
  assert.equal(lengths.length, names.length);
  assert.equal(affinities.length, names.length);
  const types = names.map((value, index) => {
    assert.match(value, /^"[A-Z][A-Z0-9_]*"$/u);
    const name = JSON.parse(value);
    assert.match(lengths[index], /^\d+$/u);
    assert.equal(Number(lengths[index]), Buffer.byteLength(name));
    assert.match(affinities[index], /^SQLITE_AFF_[A-Z]+$/u);
    return { name, affinity: affinities[index].slice("SQLITE_AFF_".length) };
  });
  assert.equal(new Set(types.map(({ name }) => name)).size, types.length);
  return types;
}
