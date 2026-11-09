import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Identifier contexts are test inputs, not instructions to execute candidate statements. */
export function sqlServerVocabularyCases(words) {
  const cases = [];
  for (const [word, token] of words) {
    assert.match(word, /^[a-z_][a-z_0-9]*$/u);
    assert.ok(word.length <= 128);
    const identifier = token === null;
    for (const [role, sql, name, expected] of [
      ["explicit-column", `SELECT 1 AS ${word}`, word, identifier],
      ["bare-column", `SELECT checked.[${word}] FROM (SELECT 1 ${word}) AS checked`, word, identifier],
      [
        "cte",
        `WITH seed AS (SELECT 1 AS ignored), ${word} AS (SELECT 1 AS value) SELECT value FROM ${word}`,
        "value",
        identifier,
      ],
      ["explicit-relation", `SELECT 1 AS value FROM (SELECT 1 AS value) AS ${word}`, "value", identifier],
      ["bare-relation", `SELECT 1 AS value FROM (SELECT 1 AS value) ${word}`, "value", identifier],
      [
        "qualified-column",
        `SELECT fixture.${word} AS value FROM (SELECT 1 AS [${word}]) AS fixture`,
        "value",
        identifier,
      ],
      ["quoted-cte", `WITH [${word}] AS (SELECT 1 AS value) SELECT value FROM [${word}]`, "value", true],
      ["assignment-alias", `SELECT ${word}=1`, word, identifier],
    ])
      cases.push({ id: cases.length, word, role, sql, name, expected });
  }
  return cases;
}

const expectedSqlError = (error) =>
  error?.diagnostics?.length > 0 &&
  error.diagnostics.every((row) => /^42/u.test(row.state) && ![229, 230].includes(row.native));
const literal = (value) => `N'${value.replaceAll("'", "''")}'`;
function described(rows, item) {
  if (rows.length && rows.every((row) => row.error_number != null)) {
    const errors = [...new Set(rows.map((row) => Number(row.error_number)))];
    assert.ok(
      errors.every((value) => Number.isSafeInteger(value) && value > 0),
      "Invalid native error identity",
    );
    return {
      accepted: errors.some((value) => [229, 230].includes(value)) ? null : false,
      reason: errors.sort((a, b) => a - b).join(","),
    };
  }
  if (rows.length === 1 && rows[0].error_number == null && Number(rows[0].column_ordinal) === 1)
    return {
      accepted: rows[0].name === item.name,
      reason: rows[0].name === item.name ? "native-accepted" : "name-mismatch",
    };
  return { accepted: null, reason: "metadata-unavailable-or-ambiguous" };
}

/** Explicit owned-session audit. Only native description calls run; candidates never execute. */
export async function auditSqlServerVocabulary(client, major, compatibilityLevel, options = {}) {
  const facts =
    options.facts ??
    JSON.parse(await readFile(new URL("../../grammar/sqlserver/vocabulary/facts.json", import.meta.url), "utf8"));
  assert.equal(facts.formatVersion, 1);
  const profile = facts.profiles.find((profile) => profile.major === major);
  assert.ok(profile?.compatibilityLevels.includes(compatibilityLevel), "Unqualified SQL Server vocabulary profile");
  const words = [...facts.common, ...profile.words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert.ok(words.length, "Empty SQL Server vocabulary inventory");
  assert.equal(new Set(words.map(([name]) => name)).size, words.length);
  const cases = sqlServerVocabularyCases(words),
    results = new Map();
  const ordered = [...cases].sort((a, b) => Number(b.expected) - Number(a.expected) || a.id - b.id);
  let batches = 0,
    fallbackBatches = 0,
    individualDescriptions = 0,
    descriptorFallbacks = 0;
  const individually = async (item) => {
    individualDescriptions++;
    try {
      return described(
        await client.all(
          `SELECT error_number,column_ordinal,name FROM sys.dm_exec_describe_first_result_set(${literal(item.sql)},NULL,0)`,
        ),
        item,
      );
    } catch (error) {
      if (!expectedSqlError(error)) throw error;
      return { accepted: false, reason: error.diagnostics.map((row) => `${row.state}:${row.native}`).join(",") };
    }
  };
  for (let start = 0; start < ordered.length; start += 64) {
    const batch = ordered.slice(start, start + 64),
      ids = new Set(batch.map((item) => item.id));
    const source = batch.map((item) => `(${item.id},${literal(item.sql)})`).join(",");
    const sql = `SELECT candidate.probe_id,info.error_number,info.name,info.column_ordinal FROM (VALUES ${source}) AS candidate(probe_id,sql_text) OUTER APPLY sys.dm_exec_describe_first_result_set(candidate.sql_text,NULL,0) AS info`;
    batches++;
    let rows;
    try {
      rows = await client.all(sql);
    } catch (error) {
      if (!expectedSqlError(error)) throw error;
      fallbackBatches++;
      for (const item of batch) results.set(item.id, await individually(item));
      continue;
    }
    const byId = new Map();
    for (const row of rows) {
      const id = Number(row.probe_id);
      assert.ok(Number.isSafeInteger(id) && ids.has(id), "Unexpected native vocabulary probe identity");
      const descriptors = byId.get(id) ?? [];
      descriptors.push(row);
      byId.set(id, descriptors);
    }
    assert.equal(byId.size, batch.length, "Missing native vocabulary descriptors");
    for (const item of batch) {
      const descriptors = byId.get(item.id);
      const result = described(descriptors, item);
      if (result.accepted === null && result.reason === "metadata-unavailable-or-ambiguous" && descriptors.length > 1) {
        descriptorFallbacks++;
        results.set(item.id, await individually(item));
      } else results.set(item.id, result);
    }
  }
  assert.equal(results.size, cases.length);
  const mismatches = [],
    permissions = new Map(words.map(([word]) => [word, 0]));
  for (const item of cases) {
    const result = results.get(item.id);
    if (result.accepted) permissions.set(item.word, permissions.get(item.word) | (1 << (item.id % 8)));
    if (result.accepted !== item.expected)
      mismatches.push({
        word: item.word,
        role: item.role,
        expected: item.expected,
        accepted: result.accepted,
        reason: result.reason,
      });
  }
  return {
    formatVersion: 1,
    profile: "sqlserver-source-vocabulary-context-v1",
    toolDigest: `sha256:${createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex")}`,
    contexts: cases.slice(0, 8).map((item) => item.role),
    major,
    compatibilityLevel,
    sourceDigest: profile.sourceDigest,
    wordsDigest: profile.wordsDigest,
    declarations: words.length,
    probes: cases.length,
    batches,
    fallbackBatches,
    individualDescriptions,
    descriptorFallbacks,
    status: mismatches.some((row) => row.accepted === null)
      ? "native-unavailable"
      : mismatches.length
        ? "source-mismatch"
        : "matched",
    mismatches,
    permissions: [...permissions],
  };
}
