import assert from "node:assert/strict";

/** Independent interpretation of recorded source predicates for native matrix qualification. */
export function sqliteVocabularyProbes(facts, version, compileOptions) {
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const profile = facts.profiles.filter((profile) => compare(profile.version, version) <= 0).at(-1);
  assert.ok(profile, "No source vocabulary at the actual SQLite version");
  const pack = facts.packs[profile.pack],
    enabled = new Set(compileOptions.map((option) => option.split("=")[0].replace(/^SQLITE_/u, "")));
  const condition = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return enabled.has(value);
    if (value[0] === "not") return !condition(value[1]);
    if (value[0] === "and") return condition(value[1]) && condition(value[2]);
    assert.equal(value[0], "or");
    return condition(value[1]) || condition(value[2]);
  };
  const words = [...facts.common, ...pack.words].sort(([a], [b]) => compare(a, b));
  const active = [],
    probes = [];
  for (const [name, , groups, fallback, direct, contextual, , pattern] of words) {
    const keyword = groups.some((group) => condition(pack.masks[group]));
    if (keyword) active.push(name);
    const isName = !keyword || condition(fallback) || contextual || !!(direct & 4);
    const bare = !keyword || condition(fallback) || contextual || !!(direct & 2);
    const bareColumn = !keyword || (!pattern && bare);
    for (const [role, sql, expected] of [
      ["explicit-column", `SELECT 1 AS ${name}`, isName],
      ["bare-column", `SELECT fixture."${name}" FROM (SELECT 1 ${name}) AS fixture`, bareColumn],
      ["cte", `WITH seed AS (SELECT 1 AS n), ${name} AS (SELECT 1 AS n) SELECT n FROM ${name}`, isName],
      ["explicit-relation", `WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture AS ${name}`, isName],
      ["bare-relation", `WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture ${name}`, bare],
      [
        "qualified-column",
        `WITH fixture AS (SELECT 1 AS "${name}") SELECT fixture.${name} AS value FROM fixture`,
        isName,
      ],
      ["quoted", `WITH "${name}" AS (SELECT 1 AS value) SELECT value FROM "${name}"`, true],
    ])
      probes.push({ name, role, sql, expected });
  }
  return { profile: profile.version, sourceDigest: profile.sourceDigest, words: active.sort(), probes };
}
