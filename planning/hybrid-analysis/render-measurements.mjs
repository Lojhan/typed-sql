import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = new URL("./", import.meta.url);
const read = async (name) => JSON.parse(await readFile(new URL(name, directory), "utf8"));
const [bundle, repository, installation, project] = await Promise.all([
  read("bundle-measurements.json"),
  read("repository-measurements.json"),
  read("installation-measurements.json"),
  read("project-measurements.json"),
]);
const check = process.argv.slice(2).includes("--check");
assert.ok(process.argv.slice(2).every((argument) => argument === "--check"));
const pin = bundle.sourceRevision;
assert.match(pin, /^[a-f0-9]{40}$/u);
for (const report of [repository, installation, project])
  assert.equal(report.sourceRevision, pin, "Refresh all cost reports at the same code revision");
const ids = (report) => [...new Set(report.rows.map((row) => row.grammar))].sort();
assert.deepEqual(ids(bundle), ids(installation));
assert.deepEqual(ids(bundle), ids(project));
const kib = (bytes) => (bytes / 1024).toFixed(1);
const mib = (bytes) => (bytes / 1024 / 1024).toFixed(2);
const number = (value) => value.toLocaleString("en-US");
const delta = (value) => `${value >= 0 ? "+" : "−"}${number(Math.abs(value))}`;
const table = (headers, rows) => [
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.join(" | ")} |`),
  "",
];
const graphs = new Map(bundle.rows.map((row) => [`${row.grammar}:${row.scenario}`, row]));
const publications = new Map(Object.values(installation.packages).map((row) => [row.name, row]));
const before = new Map(bundle.comparisonBaseline.rows.map((row) => [`${row.grammar}:${row.scenario}`, row]));
const names = ids(bundle);
const size = (row) => `${kib(row.minifiedBytes)} / ${kib(row.gzipBytes)}`;
for (const row of bundle.rows.filter((row) => ["rootTag", "queryTag", "profile", "frozenHost"].includes(row.scenario)))
  assert.deepEqual(row.globalCatalogInputs, [], "Consumer graphs must exclude global catalogs");
const bundleText = [
  "# Bundle and installation measurements",
  "",
  `The [bundle JSON](./bundle-measurements.json) and [installation JSON](./installation-measurements.json) measure committed source \`${pin}\`. Bundles compare against \`${bundle.comparisonBaseline.sourceRevision}\` using the same tool, Node ${bundle.nodeVersion}, esbuild ${bundle.esbuildVersion}, minified ESM, Node platform, ES2022, tree-shaking, gzip level 9 and Brotli quality 11. Sizes below use KiB (1,024 bytes) or MiB (1,048,576 bytes).`,
  "",
  "## Compatibility analyzers",
  "",
  "These factory exports retain dynamic version selection and all existing maintained offline rules. Differences include source vocabulary, semantic fixes and package boundaries; they do not isolate savings attributable to contracts.",
  "",
  ...table(
    ["Grammar", "Earlier minified / gzip KiB", "Current minified / gzip KiB"],
    names.map((id) => [id, size(before.get(`${id}:analyzer`)), size(graphs.get(`${id}:analyzer`))]),
  ),
  "## Explicit analyzer selection",
  "",
  "Selected cores request exact native query evidence for unmapped routines. PostgreSQL/MySQL cores retain their maintained families; DuckDB has complementary optional overload packs. SQLite/SQL Server each retain one maintained catalog with version/compatibility gates. These are measured distribution boundaries, not production popularity rankings.",
  "",
  ...table(
    ["Grammar", "Import scenario", "Minified KiB", "Gzip KiB", "Generated retained input KiB"],
    bundle.rows
      .filter((row) => row.scenario.startsWith("analyzer:"))
      .map((row) => [
        row.grammar,
        `\`${row.scenario}\``,
        kib(row.minifiedBytes),
        kib(row.gzipBytes),
        kib(row.generatedInputBytes),
      ]),
  ),
  "Generated input counts uncompressed attributed input bytes, not compressed savings. Core-plus-pack samples include composition/options overhead and can exceed a direct full selected-analyzer import. Selection does not remove other exports from an installed package.",
  "",
  "## Consumer graphs",
  "",
  ...table(
    ["Grammar", "Root tag minified / gzip KiB", "Profile minified / gzip KiB", "Frozen host minified / gzip KiB"],
    names.map((id) => [
      id,
      ...["rootTag", "profile", "frozenHost"].map((scenario) => size(graphs.get(`${id}:${scenario}`))),
    ]),
  ),
  "Root/query tags, profiles and frozen hosts retain zero global catalog inputs. Frozen hosts include contract loading and compiler helpers, so their bytes are not comparable functionality to an analyzer-only export. Ordinary tags already excluded large catalogs before this change. Runtime renderer/value plans and required codecs remain in application output. The [commerce report](./project-size.md) measures those actual used plans separately.",
  "",
  "## Published installation payload",
  "",
  ...table(
    [
      "Grammar",
      "Grammar files MiB",
      "Grammar dependency closure MiB",
      "With compiler/contracts MiB",
      "Grammar tarball KiB",
    ],
    installation.rows.map((row) => [
      row.grammar,
      mib(row.grammarPackage.bytes),
      mib(row.grammarClosure.payloadBytes),
      mib(row.withCompilerAndContracts.payloadBytes),
      kib(publications.get(`@typed-sql/${row.grammar}`).tarball.bytes),
    ]),
  ),
  "Installation uses fresh isolated offline pnpm installs of built tarballs at the named revision. It counts published file contents once per package name/version, including declarations/maps; it excludes filesystem allocation, pnpm store, application-installed drivers and engine binaries. It is neither bundle size nor total disk usage. Full package exports remain installed even when a consumer imports one core.",
  "",
  "## Reproduction",
  "",
  "```sh",
  "node planning/hybrid-analysis/measure-bundles.mjs HEAD planning/hybrid-analysis/bundle-measurements.json <same-tool-baseline.json>",
  "node planning/hybrid-analysis/measure-installation.mjs",
  "node planning/hybrid-analysis/render-measurements.mjs",
  "```",
  "",
  "Use the exact named code revision and repository-pinned dependencies; installation additionally requires its built publication artifacts. JSON retains source/tool/lockfile identities, output digests, attribution and external dependency versions. Measurements are byte evidence, not native query qualification. Architecture acceptance remains tracked in the [acceptance audit](./acceptance-audit.md).",
  "",
];
const category = (row, name, field = "lines") => row.categories[name]?.[field] ?? 0;
const base = repository.rows.base,
  old = repository.rows.exhaustiveProposal,
  current = repository.rows.current;
const definitions = [
  ["All tracked text", (row) => row.totals.lines],
  ["Maintained package source", (row) => category(row, "packageSource", "maintainedCodeLines")],
  ["Generated package source", (row) => category(row, "packageSource", "generatedCodeLines")],
  ["Tests / E2E source", (row) => category(row, "testSource")],
  ["Tooling source", (row) => category(row, "toolingSource")],
  ["Other source, including planning tools", (row) => category(row, "otherSource")],
  ["Captured vendor catalog JSON", (row) => category(row, "capturedCatalogData")],
  ["Other audit / fixture / report data", (row) => category(row, "auditFixtureAndReportData")],
  ["Documentation", (row) => category(row, "documentation")],
];
const packageNames = Object.keys(current.packages)
  .filter((id) => {
    const row = current.packages[id],
      previous = base.packages[id];
    return row.generatedCodeLines || row.maintainedCodeLines !== (previous?.maintainedCodeLines ?? 0);
  })
  .sort();
const previousTopology = (await readFile(new URL("repository-size.md", directory), "utf8")).replace(/\r\n/gu, "\n");
const topology = /## Current topology\n+(```text\n[\s\S]*?\n```)/u.exec(previousTopology)?.[1];
assert.ok(topology, "Maintain a repository topology description");
const repositoryText = [
  "# Repository topology and tracked-line accounting",
  "",
  `The [JSON inventory](./repository-measurements.json) measures \`${pin}\` against PR base \`${base.revision}\` and exhaustive proposal \`${old.revision}\`. Physical UTF-8 lines include comments and blanks. They are not semantic statements, maintenance effort, installed payload or bundle bytes.`,
  "",
  `The direction change removes **${number(old.totals.lines - current.totals.lines)} tracked text lines** relative to the exhaustive proposal. Captured vendor catalog JSON is absent. That proposal's +486,674 / −67,823 diff is reproduced independently by Git numstat. At this source pin the replacement diff is **${delta(repository.comparisons.currentProposal.additions)} / −${number(repository.comparisons.currentProposal.deletions)}**.`,
  "",
  ...table(
    ["Tracked content", "PR base", "Exhaustive proposal", "Current", "Current − base"],
    definitions.map(([name, value]) => [
      name,
      ...[base, old, current].map((row) => number(value(row))),
      delta(value(current) - value(base)),
    ]),
  ),
  `Maintained package source grows by ${number(category(current, "packageSource", "maintainedCodeLines") - category(base, "packageSource", "maintainedCodeLines"))} lines; generated package source grows by ${number(category(current, "packageSource", "generatedCodeLines") - category(base, "packageSource", "generatedCodeLines"))}. The total includes restored baseline catalogs plus compact vocabulary/codec projections, not a new exhaustive function corpus. Tests and retained audit metadata are separate categories. Existing generated example schemas contribute 4,082 lines in every compared revision.`,
  "",
  "## Package source ownership",
  "",
  ...table(
    ["Package", "Maintained lines", "Maintained Δ", "Generated lines", "Generated Δ"],
    packageNames.map((id) => {
      const row = current.packages[id],
        previous = base.packages[id];
      return [
        `\`${id}\``,
        number(row.maintainedCodeLines),
        delta(row.maintainedCodeLines - (previous?.maintainedCodeLines ?? 0)),
        number(row.generatedCodeLines),
        delta(row.generatedCodeLines - (previous?.generatedCodeLines ?? 0)),
      ];
    }),
  ),
  "A generated header must occur in the leading comment preamble; mixed generated blocks inside maintained files are not separated. Package counts include optional development/native paths and do not imply those paths enter application bundles. Complete category totals, binary bytes, largest inputs and independent Git diff reconciliation remain in JSON.",
  "",
  "## Current topology",
  topology.trim(),
  "",
  "Each grammar also owns compact source-derived vocabulary under `src/vocabulary/`; its pure compatibility identity stays outside the vocabulary dependency graph. Pinned source facts/locks and qualification deltas live under `grammar/<grammar>/`. Ordinary builds use checked-in facts and do not fetch vendor sources. Metadata discovery and native qualification remain independent from the maintained semantic rules.",
  "",
  "## Reproduction",
  "",
  "```sh",
  "node planning/hybrid-analysis/measure-repository.mjs HEAD planning/hybrid-analysis/repository-measurements.json",
  "node planning/hybrid-analysis/render-measurements.mjs",
  "```",
  "",
  "The collector reads exact Git trees/blobs, excluding build output and installed files. The revision pin avoids treating later edits to these measurement reports as measured source. This is current accounting, not a prediction for unfinished work. See [bundle/install costs](./bundle-size.md), [project costs](./project-size.md) and the [acceptance audit](./acceptance-audit.md).",
  "",
];
let comparisons = 0;
for (const row of project.rows) {
  assert.ok(typeof row.serverEvidence === "string" && row.serverEvidence.length > 0);
  for (const file of row.coverage)
    for (const result of file.compatibilityComparison) {
      assert.equal(result.identicalAnalysis, true);
      comparisons++;
    }
}
const first = (row) => row.workloads.find((workload) => workload.copies === 1);
const largest = (row) => row.workloads.reduce((left, right) => (left.copies > right.copies ? left : right));
const projectText = [
  "# Commerce project size and growth",
  "",
  `The [JSON report](./project-measurements.json) measures \`${pin}\` with Node ${project.nodeVersion} and esbuild ${project.esbuildVersion}. It discovers every ledger grammar, maintained commerce query file and matching public core export. There is no benchmark function-name list or copied vendor corpus. Schema inputs come from the example DDL parser, not live introspection.`,
  "",
  "## Selected-core coverage",
  "",
  `All **${comparisons} finite candidate analyses** are identical between selected cores and compatibility analyzers, including columns, ordered parameters, diagnostics and semantic facts. Every TypeScript module still compiles. Runtime-sized rendering stays explicit and is excluded from exact contracts. These are curated example profiles, not production popularity or proof for arbitrary SQL.`,
  "",
  ...table(
    ["Grammar", "Selected core", "Example version", "Exact candidates", "Known codecs"],
    project.rows.map((row) => [
      row.grammar,
      `\`${row.coreEntry}\``,
      row.serverEvidence,
      first(row).collectedCandidates,
      first(row).knownCodecCandidates,
    ]),
  ),
  "Known codecs establish modeled representations, not full nullability, JSON shape, precision or acceptance. Contracts below have `offline-rule` provenance; no native qualification is manufactured. SQL assets contribute artifacts but are omitted from runtime template bundles.",
  "",
  "## Used runtime output",
  "",
  ...table(
    ["Grammar", "Renderer only KiB / gzip", "With value plans KiB / gzip", "One module through barrel KiB / gzip"],
    project.rows.map((row) => {
      const workload = first(row);
      return [
        row.grammar,
        ...["rendererOnlyBundle", "withValuePlansBundle", "selectedModuleThroughBarrel"].map(
          (key) => `${kib(workload[key].bytes)} / ${kib(workload[key].gzipBytes)}`,
        ),
      ];
    }),
  ),
  "The tool rejects schema snapshots, durable envelopes, global analyzer catalogs and native acquisition modules in these runtime graphs. Selecting one module through a barrel retains exactly one application module, with the same minified byte count at all measured scales. Compressed sizes/digests can vary slightly with minifier naming. Required renderer/value-plan/codec bytes remain.",
  "",
  "## Synthetic exact-query growth",
  "",
  "Copies add SQL comments to create distinct exact identities; they do not add business features. The largest measured scale is:",
  "",
  ...table(
    ["Grammar", "Copies", "Contracts", "Durable file KiB", "Framed closure gzip KiB", "Standalone plan KiB"],
    project.rows.map((row) => {
      const workload = largest(row);
      return [
        row.grammar,
        workload.copies,
        workload.uniqueContracts,
        kib(workload.durableFileBytes),
        kib(workload.durableClosure.gzipBytes),
        kib(workload.valuePlans.bytes),
      ];
    }),
  ),
  "Closure compression uses sorted name/NUL/length/NUL/content framing; it is not a tarball or installation size. Standalone plan JSON is measured separately and is not another mandatory artifact. These offline-rule sizes exclude native descriptor/reconciliation overhead. The [native commerce report](./native-projects.md) separately measures actual qualified subsets and failed/unsupported classes across all five grammars; it does not establish complete native application support.",
  "",
  "## Schema-input growth",
  "",
  ...table(
    ["Grammar", "Relations / KiB at each scale"],
    project.rows.map((row) => [
      row.grammar,
      row.schemaGrowth.map((sample) => `${sample.totalRelations} / ${kib(sample.snapshot.bytes)}`).join("; "),
    ]),
  ),
  "This experiment adds unused product-shaped relations and validates the resulting snapshot. It isolates serialization growth, rather than pretending to model independently designed business tables or a complete native catalog.",
  "",
  "## Reproduction",
  "",
  "```sh",
  "pnpm build",
  "node --import tsx planning/hybrid-analysis/measure-projects.mjs",
  "node planning/hybrid-analysis/render-measurements.mjs",
  "```",
  "",
  "Use clean library/corpus sources at the named revision. The collector exports and reopens real artifacts in an owned temporary directory, checks contract counts and runtime dependency graphs, records source/tool/lockfile/corpus identities and removes temporary files. It measures bytes, not latency. Installation, native evidence, production workload selection and full architecture acceptance remain distinct concerns.",
  "",
];
for (const [name, lines] of [
  ["bundle-size.md", bundleText],
  ["repository-size.md", repositoryText],
  ["project-size.md", projectText],
]) {
  const text = lines.join("\n"),
    path = new URL(name, directory);
  if (check)
    assert.equal((await readFile(path, "utf8")).replace(/\r\n/gu, "\n"), text, `${fileURLToPath(path)} is stale`);
  else await writeFile(path, text);
}
