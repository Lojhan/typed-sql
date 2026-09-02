import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { POSTGRES_SUPPORT_POLICY } from "../packages/postgres/dist/packages/postgres/src/index.js";

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
  if (artifact?.formatVersion === 1 && artifact?.target?.driver === "pg") artifacts.push(artifact);
}

const stable = artifacts.filter(({ target }) => target.channel === "stable");
const missingStableMajors = POSTGRES_SUPPORT_POLICY.stableMajors.filter(
  (major) => !stable.some(({ target }) => target.actualMajor === major),
);
const failingStable = stable
  .filter(({ summary }) => summary.fail !== 0)
  .map(({ target, summary }) => ({ label: target.label, failures: summary.fail }));
const latestMajor = POSTGRES_SUPPORT_POLICY.stableMajors.at(-1);
const latest = stable.find(({ target }) => target.actualMajor === latestMajor);
const canary = artifacts.find(({ target }) => target.channel === "canary");

const difference = (left, right) => [...new Set(right)].filter((value) => !new Set(left).has(value)).sort();
const canaryReview =
  latest === undefined || canary === undefined
    ? {
        status: "unavailable",
        reason: latest === undefined ? `PostgreSQL ${latestMajor} evidence is missing` : "Canary evidence is missing",
      }
    : {
        status: "reported",
        baseline: latest.target.label,
        target: canary.target.label,
        keywords: {
          added: difference(latest.evidence.keywords.values, canary.evidence.keywords.values),
          removed: difference(canary.evidence.keywords.values, latest.evidence.keywords.values),
        },
        catalog: {
          baselineRevision: latest.evidence.catalog.revision,
          canaryRevision: canary.evidence.catalog.revision,
          typeCountDelta: canary.evidence.catalog.typeCount - latest.evidence.catalog.typeCount,
          castCountDelta: canary.evidence.catalog.castCount - latest.evidence.catalog.castCount,
          routinesAdded: difference(latest.evidence.catalog.liveRoutineNames, canary.evidence.catalog.liveRoutineNames),
          routinesRemoved: difference(
            canary.evidence.catalog.liveRoutineNames,
            latest.evidence.catalog.liveRoutineNames,
          ),
        },
        syntax: canary.evidence.syntax.map((probe) => ({
          id: probe.id,
          baseline: latest.evidence.syntax.find(({ id }) => id === probe.id)?.accepted ?? "unavailable",
          canary: probe.accepted,
        })),
        introspectionFailures: canary.results.filter(
          ({ id, status }) => status === "fail" && (id.startsWith("snapshot.") || id.startsWith("catalog.")),
        ),
      };

const report = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  stable: {
    expectedMajors: POSTGRES_SUPPORT_POLICY.stableMajors,
    observed: stable.map(({ target, summary }) => ({
      label: target.label,
      version: target.actualVersion,
      pass: summary.pass,
      fail: summary.fail,
    })),
    missingMajors: missingStableMajors,
    failing: failingStable,
    complete: missingStableMajors.length === 0 && failingStable.length === 0,
  },
  canary: canaryReview,
};
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.stable.complete) throw new Error("PostgreSQL stable differential matrix is incomplete or failing");
process.stdout.write(`${report.stable.observed.length} stable PostgreSQL targets; canary ${report.canary.status}\n`);
