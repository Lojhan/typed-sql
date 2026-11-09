import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseQueryContractQualification, queryContractDigest } from "../../packages/analysis/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
let output = join(root, "planning/hybrid-analysis");
if (args[0] === "--output-directory") {
  args.shift();
  assert.ok(args[0] && !args[0].startsWith("--"));
  output = resolve(args.shift());
}
assert.ok(args.length && args.every((arg) => !arg.startsWith("--")), "Supply explicit native project JSON files");
const grammarIds = Object.keys(
  JSON.parse(await readFile(join(root, "grammar/features/ledger.json"), "utf8")).dialects,
).sort();
const profiles = [],
  labels = new Set(),
  evidenceObservations = {},
  queryObservations = {};
for (const file of args) {
  const bytes = await readFile(file),
    report = JSON.parse(bytes);
  assert.equal(report.formatVersion, 1);
  assert.ok(grammarIds.includes(report.grammar.id));
  assert.ok(!labels.has(report.label), "Choose exactly one report per profile");
  labels.add(report.label);
  assert.match(report.sourceRevision, /^[a-f0-9]{40}$/u);
  for (const [path, digest] of [
    ["planning/hybrid-analysis/measure-native-project.mjs", report.toolDigest],
    [report.fixtureProducer.path, report.fixtureProducer.digest],
  ]) {
    assert.ok(path.startsWith("planning/hybrid-analysis/") && !path.includes(".."));
    assert.match(digest, /^[a-f0-9]{64}$/u);
    assert.equal(
      hash(execFileSync("git", ["show", `${report.sourceRevision}:${path}`], { cwd: root })),
      digest,
      "Measurement source must match its committed producer",
    );
  }
  assert.equal(report.fixture.ownedDatabaseRemovedBeforeOffline, true);
  assert.ok(Number.isSafeInteger(report.fixture.tables) && report.fixture.tables > 0);
  assert.equal(report.offlineNativeCalls, 0);
  assert.ok(report.observations.length > 0);
  assert.equal(new Set(report.observations.map((row) => row.copies)).size, report.observations.length);
  const baseCount = report.observations[0].finiteCandidates / report.observations[0].copies;
  let acquired = 0,
    inspected = 0;
  const referencedEvidence = new Set();
  for (const row of report.observations) {
    for (const value of [
      row.copies,
      row.finiteCandidates,
      row.admitted,
      row.qualified,
      ...Object.values(row.counts),
      row.durable.bytes,
      row.durable.files,
      row.cache.bytes,
      row.cache.files,
    ])
      assert.ok(Number.isSafeInteger(value) && value >= 0);
    assert.ok(row.copies > 0 && row.finiteCandidates > 0);
    assert.equal(row.finiteCandidates, baseCount * row.copies);
    assert.equal(
      Object.values(row.counts).reduce((sum, value) => sum + value, 0),
      row.finiteCandidates,
    );
    assert.equal(row.counts.qualified ?? 0, row.qualified);
    assert.equal(row.finiteCandidates - (row.counts.declined ?? 0), row.admitted);
    assert.equal(row.admittedSubsetComplete, row.admitted > 0 && row.admitted === row.qualified);
    assert.equal(row.completeProject, report.excluded.length === 0 && row.qualified === row.finiteCandidates);
    assert.equal(row.queries.length, baseCount);
    assert.ok(row.contextAttempts.length >= 1 && row.contextAttempts.length <= 3);
    assert.equal(row.contextAttempts.at(-1).status, "observed");
    assert.ok(row.contextAttempts.slice(0, -1).every((attempt) => attempt.status === "context-changed"));
    for (const value of [
      row.contextInspectionMs,
      row.acquisitionMs,
      row.reconciliationMs,
      row.acquisitionAndPublicationMs,
      row.offlineReloadAndCheckMs,
    ])
      assert.ok(Number.isFinite(value) && value >= 0);
    for (const query of row.queries) {
      assert.match(query.sqlDigest, /^[a-f0-9]{64}$/u);
      if (query.evidenceDigest) {
        referencedEvidence.add(query.evidenceDigest);
        const observation = report.evidenceObservations[query.evidenceDigest];
        assert.ok(observation);
        assert.equal(queryContractDigest(observation), query.evidenceDigest);
        assert.deepEqual(observation.nativeEvidence.adapter, report.adapter);
        parseQueryContractQualification(observation.qualification, observation.nativeEvidence);
      }
      if (query.status === "qualified") assert.ok(query.evidenceDigest);
    }
    acquired += row.admitted;
    inspected += row.contextAttempts.length;
  }
  assert.deepEqual([...referencedEvidence].sort(), Object.keys(report.evidenceObservations).sort());
  assert.equal(report.acquisitions, acquired);
  assert.equal(report.inspections, inspected);
  for (const [digest, evidence] of Object.entries(report.evidenceObservations)) {
    if (evidenceObservations[digest]) assert.deepEqual(evidenceObservations[digest], evidence);
    evidenceObservations[digest] = evidence;
  }
  const { evidenceObservations: _evidence, observations, ...metadata } = report;
  profiles.push({
    ...metadata,
    reportDigest: hash(bytes),
    observations: observations.map(({ queries, ...observation }) => {
      const queriesDigest = queryContractDigest(queries);
      if (queryObservations[queriesDigest]) assert.deepEqual(queryObservations[queriesDigest], queries);
      queryObservations[queriesDigest] = queries;
      return { ...observation, queriesDigest };
    }),
  });
}
profiles.sort((a, b) => a.label.localeCompare(b.label));
const measured = [...new Set(profiles.map((profile) => profile.grammar.id))].sort();
const result = {
  formatVersion: 1,
  measuredGrammars: measured,
  missingGrammars: grammarIds.filter((id) => !measured.includes(id)),
  evidenceObservations,
  queryObservations,
  profiles,
};
const md = [
  "# Native commerce workload measurements",
  "",
  "Actual owned databases are provisioned from the maintained commerce schemas, introspected and removed before offline replay. The JSON retains committed producer hashes, corpus inputs, query outcomes and native qualification evidence. These are bounded workload observations, not grammar coverage or function popularity.",
  "",
  "## Base workload",
  "",
  "| Profile | Finite queries | Admitted | Qualified | Declined | Other acquisition outcomes | Unbounded files |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...profiles.map((profile) => {
    const row = profile.observations.find((row) => row.copies === 1) ?? profile.observations[0];
    return `| ${profile.label} | ${row.finiteCandidates} | ${row.admitted} | ${row.qualified} | ${row.counts.declined ?? 0} | ${row.admitted - row.qualified} | ${profile.excluded.length} |`;
  }),
  "",
  `Missing grammar measurements: ${result.missingGrammars.join(", ") || "none"}. Only the explicitly listed engine versions and compatibility profiles are measured.`,
  "",
  "## Qualified subset scaling",
  "",
  "| Profile | Copies | Qualified / finite | Durable bytes | Cache bytes | Acquire and publish ms | Offline reload and check ms |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...profiles.flatMap((profile) =>
    profile.observations.map(
      (row) =>
        `| ${profile.label} | ${row.copies} | ${row.qualified} / ${row.finiteCandidates} | ${row.durable.bytes} | ${row.cache.bytes} | ${row.acquisitionAndPublicationMs.toFixed(2)} | ${row.offlineReloadAndCheckMs.toFixed(2)} |`,
    ),
  ),
  "",
  "Artifact sizes apply to the qualified subset only. An empty closure is still a manifest; its bytes do not represent application support. Every measured project remains incomplete wherever writes, unsupported statement forms, context restrictions or unbounded rendering prevent native qualification. Zero native calls during offline replay proves reuse of the exported subset, including no useful contracts when qualification is zero.",
  "",
  "Timings are single serial observations, not percentiles or engine rankings. Acquisition/publication excludes fixture provisioning, introspection, compression, artifact byte reads and offline replay. Copies add SQL comments to exercise distinct exact-query identities; they do not add distinct business logic or database objects. Runtime bundles, package installation, schema size and external engines/drivers are separate costs. Native facets remain subject to each recorded qualification policy; qualifying runtime types does not establish exact native identities or nullability.",
  "",
  "Machine evidence: [native-project-measurements.json](./native-project-measurements.json). Reproduce using the owner `measure-*-commerce.mjs` tools, then run `node --import tsx planning/hybrid-analysis/summarize-native-projects.mjs <report.json> ...`. Server-backed tools require explicit audit connection environment variables and create/drop only their own randomly named databases. SQL Server measurements run in its hosted qualification workflow.",
  "",
];
// Validate every input before publishing either artifact.
await mkdir(output, { recursive: true });
await writeFile(join(output, "native-project-measurements.json"), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(join(output, "native-projects.md"), md.join("\n"));
console.log(
  JSON.stringify({ profiles: profiles.length, measuredGrammars: measured, missingGrammars: result.missingGrammars }),
);
