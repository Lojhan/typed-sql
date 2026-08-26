import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseManifest } from "./release-policy.mjs";

const defaultWorkspace = fileURLToPath(new URL("..", import.meta.url));
const roles = {
  postgres: {
    packages: ["@typed-sql/core", "@typed-sql/postgres", "@typed-sql/cli"],
    checks: [
      "install",
      "generation",
      "typecheck",
      "runtime",
      "drift",
      "determinism",
      "driver-compatibility",
      "query-composition",
    ],
    deterministic: true,
  },
  mysql: {
    packages: ["@typed-sql/core", "@typed-sql/mysql", "@typed-sql/cli"],
    checks: [
      "install",
      "generation",
      "typecheck",
      "runtime",
      "drift",
      "determinism",
      "driver-compatibility",
      "query-composition",
    ],
    deterministic: true,
  },
  editor: {
    packages: ["@typed-sql/language-server", "@typed-sql/ts-bridge"],
    checks: ["install", "generation", "typecheck", "hover", "diagnostics", "quick-fix", "restart"],
    deterministic: false,
  },
};
const blockerCategories = new Set([
  "inference",
  "false-rejection",
  "false-acceptance",
  "nondeterminism",
  "driver",
  "installation",
  "editor",
  "documentation",
  "security",
]);

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function exactVersion(value, label) {
  const version = string(value, label);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(version)) {
    throw new TypeError(`${label} must be an exact semantic version`);
  }
  return version;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function instant(value, label) {
  const parsed = Date.parse(string(value, label));
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO date-time`);
  return parsed;
}

function httpsUrl(value, label) {
  const parsed = new URL(string(value, label));
  if (parsed.protocol !== "https:") throw new TypeError(`${label} must use https`);
  return parsed.href;
}

function exactStrings(value, label) {
  const items = array(value, label).map((item, index) => string(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new TypeError(`${label} must not contain duplicates`);
  return items;
}

function versionedTool(value, label, expectedName) {
  const tool = object(value, label);
  const name = string(tool.name, `${label}.name`);
  if (expectedName !== undefined && name !== expectedName) {
    throw new TypeError(`${label}.name must be ${expectedName}`);
  }
  exactVersion(tool.version, `${label}.version`);
  return tool;
}

export function validateRcSoakReport(value, options) {
  const report = object(value, "RC soak report");
  if (report.schemaVersion !== 1) throw new TypeError("RC soak report schemaVersion must be 1");
  const series = string(report.series, "series");
  if (series !== options.series) throw new TypeError(`RC soak series ${series} does not match ${options.series}`);
  const candidate = string(report.candidate, "candidate");
  if (!new RegExp(`^${series.replaceAll(".", "\\.")}-rc\\.\\d+$`, "u").test(candidate)) {
    throw new TypeError(`candidate must be a ${series}-rc.N version`);
  }
  if (report.npmTag !== "next") throw new TypeError("RC soak candidate must be installed from npm next");
  const releaseCommit = string(report.releaseCommit, "releaseCommit");
  if (!/^[\da-f]{40}$/u.test(releaseCommit)) throw new TypeError("releaseCommit must be a full lowercase git SHA");
  if (!Number.isSafeInteger(report.minimumDays) || report.minimumDays < 7 || report.minimumDays > 14) {
    throw new TypeError("minimumDays must be a safe integer from 7 through 14");
  }
  const startedAt = instant(report.startedAt, "startedAt");
  const publishedAt = instant(report.publishedAt, "publishedAt");
  if (startedAt < publishedAt) throw new TypeError("startedAt cannot precede RC publication");
  const requiredEnd = startedAt + report.minimumDays * 86_400_000;
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  if (now < requiredEnd) throw new Error(`RC soak has not completed ${report.minimumDays} full days`);

  const consumers = array(report.consumers, "consumers");
  if (consumers.length < 3) throw new TypeError("RC soak requires at least three consumers");
  const seenRepositories = new Set();
  const seenConsumerIds = new Set();
  const seenRoles = new Set();
  for (const [consumerIndex, rawConsumer] of consumers.entries()) {
    const label = `consumers[${consumerIndex}]`;
    const consumer = object(rawConsumer, label);
    const consumerId = string(consumer.id, `${label}.id`);
    if (seenConsumerIds.has(consumerId)) throw new TypeError("RC consumer ids must be distinct");
    seenConsumerIds.add(consumerId);
    const role = string(consumer.role, `${label}.role`);
    if (!Object.hasOwn(roles, role)) throw new TypeError(`${label}.role must be postgres, mysql, or editor`);
    seenRoles.add(role);
    const repository = httpsUrl(consumer.repository, `${label}.repository`);
    if (seenRepositories.has(repository)) throw new TypeError("RC consumers must use distinct external repositories");
    if (/^https:\/\/github\.com\/Lojhan\/typed-sql(?:\.git)?\/?$/u.test(repository)) {
      throw new TypeError("The typed-sql monorepo cannot count as an external RC consumer");
    }
    seenRepositories.add(repository);
    if (consumer.installSource !== "registry") {
      throw new TypeError(`${label}.installSource must be registry`);
    }
    exactVersion(consumer.node, `${label}.node`);
    const packageManager = string(consumer.packageManager, `${label}.packageManager`);
    if (!/^pnpm@\d+\.\d+\.\d+$/u.test(packageManager)) {
      throw new TypeError(`${label}.packageManager must pin an exact pnpm version`);
    }
    const typescript = versionedTool(consumer.typescript, `${label}.typescript`, "typescript");
    if (!typescript.version.startsWith("7.")) throw new TypeError(`${label}.typescript must use TypeScript 7`);
    if (role === "postgres") {
      versionedTool(consumer.database, `${label}.database`, "postgresql");
      versionedTool(consumer.driver, `${label}.driver`, "pg");
    } else if (role === "mysql") {
      versionedTool(consumer.database, `${label}.database`, "mysql");
      versionedTool(consumer.driver, `${label}.driver`, "mysql2");
    } else {
      versionedTool(consumer.editor, `${label}.editor`);
    }
    const packages = object(consumer.packages, `${label}.packages`);
    for (const name of roles[role].packages) {
      if (packages[name] !== candidate) throw new TypeError(`${label}.packages must pin ${name} to ${candidate}`);
    }

    const runs = array(consumer.runs, `${label}.runs`);
    if (runs.length < 2) throw new TypeError(`${label} requires at least two successful runs`);
    const hashes = new Set();
    let firstRun = Number.POSITIVE_INFINITY;
    let lastRun = Number.NEGATIVE_INFINITY;
    for (const [runIndex, rawRun] of runs.entries()) {
      const runLabel = `${label}.runs[${runIndex}]`;
      const run = object(rawRun, runLabel);
      const at = instant(run.at, `${runLabel}.at`);
      if (at < startedAt || at > now) throw new TypeError(`${runLabel}.at is outside the measured soak window`);
      firstRun = Math.min(firstRun, at);
      lastRun = Math.max(lastRun, at);
      if (run.result !== "pass") throw new Error(`${runLabel} did not pass`);
      if (!/^[\da-f]{40}$/u.test(string(run.consumerCommit, `${runLabel}.consumerCommit`))) {
        throw new TypeError(`${runLabel}.consumerCommit must be a full lowercase git SHA`);
      }
      httpsUrl(run.evidence, `${runLabel}.evidence`);
      const checks = exactStrings(run.checks, `${runLabel}.checks`);
      for (const check of roles[role].checks) {
        if (!checks.includes(check)) throw new TypeError(`${runLabel} is missing ${check}`);
      }
      if (roles[role].deterministic) {
        const hash = string(run.generatedHash, `${runLabel}.generatedHash`);
        if (!/^[\da-f]{64}$/u.test(hash)) throw new TypeError(`${runLabel}.generatedHash must be a SHA-256 hex digest`);
        hashes.add(hash);
      }
    }
    if (firstRun > startedAt + 86_400_000) throw new Error(`${label} did not begin within the first soak day`);
    if (lastRun < requiredEnd) throw new Error(`${label} has no passing run after the minimum soak period`);
    if (roles[role].deterministic && hashes.size !== 1)
      throw new Error(`${label} generated output changed during the soak`);
  }
  for (const role of Object.keys(roles)) {
    if (!seenRoles.has(role)) throw new TypeError(`RC soak is missing an independent ${role} consumer`);
  }

  const blockers = array(report.blockers, "blockers");
  for (const [index, rawBlocker] of blockers.entries()) {
    const label = `blockers[${index}]`;
    const blocker = object(rawBlocker, label);
    string(blocker.id, `${label}.id`);
    if (!blockerCategories.has(blocker.category)) throw new TypeError(`${label}.category is unsupported`);
    if (blocker.status !== "resolved") throw new Error(`${label} remains unresolved`);
    const resolvedAt = instant(blocker.resolvedAt, `${label}.resolvedAt`);
    if (resolvedAt < startedAt || resolvedAt > now) {
      throw new TypeError(`${label}.resolvedAt is outside the soak window`);
    }
    httpsUrl(blocker.regressionTest, `${label}.regressionTest`);
  }

  const decision = object(report.decision, "decision");
  if (decision.outcome !== "go") throw new Error("RC soak decision must be go before stable publication");
  const decidedAt = instant(decision.decidedAt, "decision.decidedAt");
  if (decidedAt < requiredEnd || decidedAt > now) {
    throw new TypeError("decision.decidedAt must be inside the completed soak window");
  }
  string(decision.owner, "decision.owner");
  string(decision.rationale, "decision.rationale");
  exactStrings(decision.knownLimitations, "decision.knownLimitations");

  return {
    candidate,
    releaseCommit,
    minimumDays: report.minimumDays,
    consumerCount: consumers.length,
    blockerCount: blockers.length,
    decision: decision.outcome,
  };
}

export async function assertRcSoak(options = {}) {
  const workspace = resolve(options.workspace ?? defaultWorkspace);
  const release = await loadReleaseManifest(workspace);
  const reportPath = resolve(options.reportPath ?? join(workspace, "release", "rc-soak.json"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const result = validateRcSoakReport(report, { series: release.series, now: options.now });
  if (release.channel === "stable" && release.sourceCandidate !== result.candidate) {
    throw new Error(
      `Stable release was rehearsed from ${release.sourceCandidate}, but soak covers ${result.candidate}`,
    );
  }
  return result;
}

export async function main() {
  const result = await assertRcSoak({ reportPath: process.argv[2] });
  process.stdout.write(
    `RC soak verified: ${result.candidate}, ${result.minimumDays} days, ${result.consumerCount} consumers, ${result.blockerCount} resolved blockers\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
