import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roots = process.argv.slice(2);
if (!roots.length) throw Error("Supply native-cost report directories; this tool opens no database");
const ledger = JSON.parse(await readFile(join(root, "grammar/features/ledger.json"), "utf8"));
const grammars = Object.keys(ledger.dialects).sort();
const methods = {},
  reports = new Map(),
  seen = new Set();
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) found.push(...(await files(path)));
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(path);
  }
  return found;
}
const stats = (values) => {
  assert.ok(values.length);
  assert.ok(values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
};
for (const directory of roots)
  for (const file of await files(resolve(directory))) {
    if (seen.has(file)) continue;
    seen.add(file);
    const bytes = await readFile(file),
      report = JSON.parse(bytes);
    // An enclosing hosted artifact also contains correctness probes with different schemas.
    if (!Object.hasOwn(report, "samples") || !Object.hasOwn(report, "toolDigest")) continue;
    assert.equal(report.formatVersion, 1);
    assert.match(report.sourceRevision, /^[a-f0-9]{40}$/u);
    assert.match(report.toolDigest, /^[a-f0-9]{64}$/u);
    assert.match(report.label, /^[a-z0-9._-]{1,160}$/iu);
    assert.ok(grammars.includes(report.grammar.id));
    assert.equal(report.samples.length, 3);
    const measuredTool = execFileSync(
      "git",
      ["show", `${report.sourceRevision}:planning/hybrid-analysis/measure-native.mjs`],
      { cwd: root },
    );
    assert.equal(hash(measuredTool), report.toolDigest, "Report must identify the exact committed measurement tool");
    assert.ok(
      !methods[report.toolDigest] || JSON.stringify(methods[report.toolDigest]) === JSON.stringify(report.method),
    );
    methods[report.toolDigest] = report.method;
    const summary = {
      canonicalContractBytes: stats(report.samples.map((sample) => sample.canonicalContractBytes)),
      durableFileBytes: stats(report.samples.map((sample) => sample.durable.bytes)),
      cacheFileBytes: stats(report.samples.map((sample) => sample.cache.bytes)),
      contextInspectionMs: stats(
        report.samples.flatMap((sample) => sample.attempts.map((attempt) => attempt.contextInspectionMs)),
      ),
      staticAnalysisMs: stats(
        report.samples.flatMap((sample) => sample.attempts.map((attempt) => attempt.staticAnalysisMs)),
      ),
      acquisitionAndReconciliationMs: stats(
        report.samples.flatMap((sample) => sample.attempts.map((attempt) => attempt.acquisitionAndReconciliationMs)),
      ),
      sumOfQualificationStagesMs: stats(
        report.samples.map((sample) =>
          sample.attempts.reduce(
            (sum, attempt) =>
              sum + attempt.contextInspectionMs + attempt.staticAnalysisMs + attempt.acquisitionAndReconciliationMs,
            0,
          ),
        ),
      ),
      durableExportMs: stats(report.samples.map((sample) => sample.durableExportMs)),
      durableReloadMs: stats(report.samples.map((sample) => sample.durableReloadMs)),
      cachePublishMs: stats(report.samples.map((sample) => sample.cachePublishMs)),
      coldCacheObjectLookupMs: stats(report.samples.map((sample) => sample.coldCacheObjectLookupMs)),
      warmLookupMs: stats(report.samples.flatMap((sample) => sample.warmLookupMs)),
    };
    for (const sample of report.samples) {
      assert.match(sample.contractDigest, /^[a-f0-9]{64}$/u);
      assert.match(sample.contextDigest, /^[a-f0-9]{64}$/u);
      assert.ok(sample.attempts.length >= 1 && sample.attempts.length <= 3);
      assert.equal(sample.attempts.at(-1).outcome, "usable-recorded-context");
      assert.ok(sample.attempts.slice(0, -1).every((attempt) => attempt.outcome === "stale-context"));
      assert.equal(sample.warmLookupMs.length, 3);
      for (const value of [
        report.fixtureSchema.bytes,
        sample.canonicalContractBytes,
        sample.nativeEvidenceBytes,
        sample.valuePlanBytes,
        sample.durable.bytes,
        sample.durable.files,
        sample.cache.bytes,
        sample.cache.files,
      ])
        assert.ok(Number.isSafeInteger(value) && value > 0);
    }
    const { method: _method, ...profile } = report;
    const entry = { ...profile, reportDigest: hash(bytes), summary };
    const previous = reports.get(report.label);
    assert.ok(
      !previous || previous.reportDigest === entry.reportDigest,
      "Conflicting observations require explicit input selection",
    );
    reports.set(report.label, entry);
  }
assert.ok(reports.size, "No qualified native cost observations found");
const profiles = [...reports.values()].sort((a, b) => a.label.localeCompare(b.label));
const result = {
  formatVersion: 1,
  aggregationToolDigest: hash(await readFile(fileURLToPath(import.meta.url))),
  coverage: {
    discoveredGrammars: grammars,
    measuredGrammars: [...new Set(profiles.map((profile) => profile.grammar.id))].sort(),
    unmeasuredGrammars: grammars.filter((grammar) => !profiles.some((profile) => profile.grammar.id === grammar)),
  },
  conditions:
    "Local profiles may run concurrently on the same host. Hosted profiles use their declared runner environment. Three observations and reused owner fixtures do not establish workload latency percentiles, engine rankings or production popularity. Sum of timed qualification stages excludes untimed caller/fixture overhead.",
  methods: Object.fromEntries(Object.entries(methods).sort(([a], [b]) => a.localeCompare(b))),
  profiles,
};
const destination = join(root, "planning/hybrid-analysis/native-measurements.json");
const formatted = execFileSync(
  join(root, "node_modules/.bin/biome"),
  ["format", "--stdin-file-path=native-measurements.json"],
  { cwd: root, input: JSON.stringify(result), maxBuffer: 4 * 1024 * 1024 },
);
await writeFile(destination, formatted);
for (const { label, summary } of profiles)
  console.log(
    JSON.stringify({
      label,
      closureBytes: summary.durableFileBytes.median,
      contextMs: summary.contextInspectionMs.median,
      acquisitionMs: summary.acquisitionAndReconciliationMs.median,
      warmMs: summary.warmLookupMs.median,
    }),
  );
const median = (profile, name) => profile.summary[name].median;
const payloadRows = profiles.map(
  (profile) =>
    `| ${profile.label} | ${profile.fixtureSchema.bytes} | ${stats(profile.samples.map((sample) => sample.valuePlanBytes)).median} | ${median(profile, "canonicalContractBytes")} | ${median(profile, "durableFileBytes")} | ${median(profile, "cacheFileBytes")} |`,
);
const timingRows = profiles.map(
  (profile) =>
    `| ${profile.label} | ${median(profile, "contextInspectionMs").toFixed(1)} | ${median(profile, "acquisitionAndReconciliationMs").toFixed(1)} | ${median(profile, "coldCacheObjectLookupMs").toFixed(1)} | ${median(profile, "warmLookupMs").toFixed(1)} |`,
);
const revisions = [...new Set(profiles.map((profile) => profile.sourceRevision))].sort();
const environments = [
  ...new Set(
    profiles.map(
      (profile) =>
        `${profile.environment.platform}/${profile.environment.architecture}, Node ${profile.environment.node}`,
    ),
  ),
].sort();
const markdown = `# Native contract costs

Generated by [summarize-native.mjs](./summarize-native.mjs) from the
[machine-readable observations](./native-measurements.json). The report covers ${profiles.length}
actual owner-fixture profiles across ${result.coverage.measuredGrammars.length} grammars, with
three independently qualified acquisitions per profile. Unmeasured ledger grammars:
${result.coverage.unmeasuredGrammars.join(", ") || "none"}.

Each profile records its actual engine version, adapter/grammar identities, client environment,
SQL digest, raw observations and exact committed measurement-tool hash. Source revisions:
${revisions.map((revision) => `[${revision.slice(0, 8)}](https://github.com/Lojhan/typed-sql/commit/${revision})`).join(", ")}.
Hosted artifact provenance is recorded in [implementation evidence](./implementation.md).
These are selected qualified fixtures, not a complete application workload or all supported
engine versions, and do not establish production popularity or latency guarantees.

## Measured file contents

All values are bytes. A closure contains one actual reconciled query, its recorded context and
manifest. The schema is a separate fixture compiler input, not a complete server catalog. The
plan column is standalone JSON; it is already contained inside the contract, so these columns
must not be added together. Native evidence, qualification comparisons and provenance account
for much of the difference between a runtime plan and its durable compiler input.

| Profile | Fixture schema | Plan JSON | Canonical contract | Durable closure | Disposable cache |
| --- | ---: | ---: | ---: | ---: | ---: |
${payloadRows.join("\n")}

File-content counts exclude filesystem blocks, installation, drivers, SDK binaries and complete
application schema/catalog growth. Runtime application bundles contain their retained value
plans and codec mechanics; these contract/context/cache envelopes are development compiler
inputs. The [commerce report](./project-size.md) separately measures realistic offline project
artifacts, minified/gzip/Brotli runtime bundles and synthetic schema/identity growth. Multiplying
these one-query closure figures is not a measured native application scaling result.

## Observed timings

Values are milliseconds: median of three context/acquisition/cold-object observations and nine
warm lookups per profile. Context inspection and acquisition/reconciliation are separate stages;
raw static-analysis, durable export/reload and publication timings also remain in the JSON.
The sum-of-timed-stages statistic excludes untimed caller and fixture overhead.

| Profile | Context inspection | Acquisition + reconciliation | Reopened cache object | Warm lookup |
| --- | ---: | ---: | ---: | ---: |
${timingRows.join("\n")}

Observed client environments: ${environments.join("; ")}. Connection placement, containerization,
SDK ownership and background load depend on the owning fixture; capture details remain in
[implementation evidence](./implementation.md). Local profiles may run concurrently and
server/driver state may already be warm. These conditions do not support engine rankings or
percentile estimates. Opening a new cache object does not drop OS page caches. Recorded cache
reads retain unverified freshness and perform no native refresh.

## Reproduction

After the repository build, set \`TYPED_SQL_NATIVE_COSTS_DIRECTORY\` to an owned output directory
when running the existing native owner fixtures. PostgreSQL/MySQL use their real-database
helpers; SQLite and DuckDB use their package native-contract tests. Each completed measurement
atomically publishes a profile JSON report, removes its owned temporary closures/caches, and
requires qualified evidence for every sample. A failed new observation removes its older report.
SQL Server's hosted qualification enables collection for each engine/compatibility profile.

Aggregate selected report directories without a database connection:

\`\`\`sh
node planning/hybrid-analysis/summarize-native.mjs /path/to/local-costs /path/to/hosted-costs
\`\`\`

The aggregator discovers grammar coverage from the ledger, verifies each tool hash against its
reported Git commit, rejects incomplete/invalid samples and conflicting observations, and
regenerates this page and JSON. Fetch the named hosted merge commit when its Git object
is absent locally. Native acquisition never executes candidates or binds sample application
values; its statement and facet boundaries remain those of the declared adapter profiles.
`;
await writeFile(join(root, "planning/hybrid-analysis/native-costs.md"), markdown);
