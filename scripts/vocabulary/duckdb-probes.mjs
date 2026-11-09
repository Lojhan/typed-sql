import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const compare = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

/** Explicit test-only native audit; candidates are prepared and destroyed, never executed. */
export async function assertDuckDBVocabulary(connection, version) {
  const facts = JSON.parse(
    await readFile(new URL("../../grammar/duckdb/vocabulary/facts.json", import.meta.url), "utf8"),
  );
  const profile = facts.profiles.find((profile) => profile.version === version.replace(/^v/u, ""));
  assert.ok(profile, "Native engine has no pinned DuckDB vocabulary profile");
  const words = [...facts.common, ...profile.words].sort(([a], [b]) => compare(a, b));
  const reader = await connection.runAndReadAll("SELECT keyword_name, keyword_category FROM duckdb_keywords()");
  const native = reader
    .getRowObjects()
    .map((row) => [row.keyword_name, row.keyword_category])
    .sort(compare);
  const expected = words
    .flatMap(([name, , categories]) => categories.map((category) => [name, category]))
    .sort(compare);
  assert.deepEqual(native, expected, "Pinned declarations and complete native keyword API disagree");
  const bareLabels = new Set(profile.bareLabels);
  let probes = 0;
  for (const [word, classes] of words) {
    const identifier = /[UC]/u.test(classes);
    for (const [role, sql, allowed] of [
      ["explicit column", `SELECT 1 AS ${word}`, true],
      ["bare column", `SELECT checked."${word}" FROM (SELECT 1 ${word}) AS checked`, bareLabels.has(word)],
      ["CTE", `WITH seed AS (SELECT 1), ${word} AS (SELECT 1 AS x) SELECT x FROM ${word}`, identifier],
      ["explicit relation", `SELECT 1 FROM (SELECT 1) AS ${word}`, identifier],
      ["bare relation", `SELECT 1 FROM (SELECT 1) ${word}`, identifier],
      ["qualified column", `SELECT fixture.${word} FROM (SELECT 1 AS "${word}") AS fixture`, true],
      ["quoted CTE", `WITH "${word}" AS (SELECT 1 AS x) SELECT x FROM "${word}"`, true],
      ["prefix column", `SELECT ${word}: 1`, identifier],
    ]) {
      let statement;
      try {
        statement = await connection.prepare(sql);
        assert.ok(allowed, `${version}: ${word} unexpectedly accepted as ${role}`);
      } catch (error) {
        if (allowed) throw error;
        // The wrapper also rejects a keyword parsed as an operator instead of the requested alias.
        assert.ok(
          error instanceof Error &&
            (error.message.startsWith("Parser Error:") ||
              (role === "bare column" && error.message.startsWith("Binder Error:"))),
          `${version}: ${word} ${role}: ${error}`,
        );
      } finally {
        statement?.destroySync();
      }
      probes++;
    }
    const statement = await connection.prepare(`SELECT "${word}" + 1 FROM (SELECT 1 AS "${word}") AS fixture`);
    try {
      assert.equal(statement.columnName(0), `("${word}" + 1)`, `${version}: ${word} native expression label`);
    } finally {
      statement.destroySync();
    }
  }
  return { version, declarations: words.length, nativeRecords: native.length, probes, labelProbes: words.length };
}
