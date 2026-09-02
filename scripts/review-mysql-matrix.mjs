import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MYSQL_SUPPORT_POLICY } from "../packages/mysql/dist/packages/mysql/src/index.js";

const options = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) throw new TypeError(`Invalid argument ${name ?? "<missing>"}`);
  options[name.slice(2)] = value;
}
if (typeof options.input !== "string" || options.input.length === 0) throw new TypeError("--input is required");
if (typeof options.output !== "string" || options.output.length === 0) throw new TypeError("--output is required");

const input = resolve(options.input);
const files = (await readdir(input)).filter((name) => name.endsWith(".json")).sort();
const artifacts = [];
for (const file of files) {
  const artifact = JSON.parse(await readFile(join(input, file), "utf8"));
  if (artifact?.formatVersion === 1 && artifact?.target?.driver === "mysql2") artifacts.push(artifact);
}

const profiles = Object.freeze(["default", "lexical", "numeric"]);
const expectedStable = MYSQL_SUPPORT_POLICY.stable.flatMap(({ series, matrixVersion }) =>
  profiles.map((modeProfile) => ({ series, matrixVersion, modeProfile, key: `${series}/${modeProfile}` })),
);
const stable = artifacts.filter(({ target }) => target.channel === "stable");
const keyFor = ({ actualSeries, modeProfile }) => `${actualSeries}/${modeProfile}`;
const missing = expectedStable.filter(
  ({ series, matrixVersion, modeProfile }) =>
    !stable.some(
      ({ target }) =>
        target.actualSeries === series &&
        target.actualVersion.startsWith(matrixVersion) &&
        target.modeProfile === modeProfile,
    ),
);
const unexpected = stable
  .filter(({ target }) => !expectedStable.some(({ key }) => key === keyFor(target)))
  .map(({ target }) => target.label);
const duplicateKeys = [...new Set(stable.map(({ target }) => keyFor(target)))].filter(
  (key) => stable.filter(({ target }) => keyFor(target) === key).length > 1,
);
const failing = stable
  .filter(({ summary }) => summary.fail !== 0)
  .map(({ target, summary }) => ({ label: target.label, failures: summary.fail }));

const latestSeries = MYSQL_SUPPORT_POLICY.stable.at(-1).series;
const baseline = stable.find(({ target }) => target.actualSeries === latestSeries && target.modeProfile === "default");
const canary = artifacts.find(({ target }) => target.channel === "canary" && target.modeProfile === "default");
const difference = (left, right) => [...new Set(right)].filter((value) => !new Set(left).has(value)).sort();
const canaryReview =
  baseline === undefined || canary === undefined
    ? {
        status: "unavailable",
        reason:
          baseline === undefined ? `MySQL ${latestSeries}/default evidence is missing` : "Canary evidence is missing",
      }
    : {
        status: "reported",
        baseline: baseline.target.label,
        target: canary.target.label,
        failures: canary.results.filter(({ status }) => status === "fail"),
        keywords: {
          added: difference(baseline.evidence.keywords.values, canary.evidence.keywords.values),
          removed: difference(canary.evidence.keywords.values, baseline.evidence.keywords.values),
        },
        collations: {
          added: difference(baseline.evidence.collations.values, canary.evidence.collations.values),
          removed: difference(canary.evidence.collations.values, baseline.evidence.collations.values),
        },
        catalog: {
          baselineRevision: baseline.evidence.catalog.revision,
          canaryRevision: canary.evidence.catalog.revision,
          typeCountDelta: canary.evidence.catalog.typeCount - baseline.evidence.catalog.typeCount,
          coercionCountDelta: canary.evidence.catalog.coercionCount - baseline.evidence.catalog.coercionCount,
          routineCountDelta: canary.evidence.catalog.routineCount - baseline.evidence.catalog.routineCount,
        },
        syntax: canary.evidence.syntax.map((probe) => ({
          id: probe.id,
          baseline: baseline.evidence.syntax.find(({ id }) => id === probe.id)?.accepted ?? "unavailable",
          canary: probe.accepted,
        })),
      };

const report = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  stable: {
    expected: expectedStable,
    observed: stable.map(({ target, summary }) => ({
      label: target.label,
      version: target.actualVersion,
      series: target.actualSeries,
      modeProfile: target.modeProfile,
      pass: summary.pass,
      fail: summary.fail,
    })),
    missing,
    unexpected,
    duplicateKeys,
    failing,
    complete: missing.length === 0 && unexpected.length === 0 && duplicateKeys.length === 0 && failing.length === 0,
  },
  canary: canaryReview,
};
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.stable.complete) throw new Error("MySQL stable differential matrix is incomplete or failing");
process.stdout.write(`${report.stable.observed.length} stable MySQL targets; canary ${report.canary.status}\n`);
