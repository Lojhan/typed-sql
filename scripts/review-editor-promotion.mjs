import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const read = (path) => readFile(join(workspace, path), "utf8");
const assessment = JSON.parse(await read("editor-promotion.json"));
const release = JSON.parse(await read("release-manifest.json"));
const workflow = await read(".github/workflows/ci.yml");
const support = await read("packages/ts-bridge/src/support.ts");
const parity = await read("packages/language-server/test/soundness.test.ts");
const artifactSmoke = await read("scripts/assert-editor-artifacts.mjs");
const zedBuild = await read("scripts/build-zed-artifact.mjs");
const performance = JSON.parse(await read("performance-budgets.json"));
const compatibility = await read("docs/reference/compatibility.md");
const editors = await read("docs/guides/editors.md");
const upgrade = await read("docs/guides/upgrading-from-v1.md");

assert.equal(assessment.formatVersion, 1);
assert.deepEqual(assessment.packages, ["@typed-sql/ts-bridge", "@typed-sql/language-server"]);
assert.ok(Number.isSafeInteger(assessment.requiredConsecutiveCandidates));
assert.ok(assessment.requiredConsecutiveCandidates >= 2);
assert.ok(Array.isArray(assessment.verifiedCandidates));
for (const candidate of assessment.verifiedCandidates) {
  assert.equal(typeof candidate.version, "string");
  assert.equal(typeof candidate.matrixArtifact, "string");
  assert.equal(typeof candidate.soakArtifact, "string");
}
assert.equal(
  new Set(assessment.verifiedCandidates.map(({ version }) => version)).size,
  assessment.verifiedCandidates.length,
);

const evidence = {
  supportPolicy:
    support.includes('exactVersion: "7.1.0-dev.20260824.1"') &&
    support.includes('unsupportedVersion: "reject-before-project-load"'),
  compatibilityMatrix:
    workflow.includes("typescript-editor-matrix:") &&
    workflow.includes("node: 22.11.0") &&
    workflow.includes("node: 26.x"),
  batchEditorParity:
    parity.includes("assertSemanticParity") &&
    parity.includes('name: "sqlite"') &&
    parity.includes('name: "synthetic"'),
  packagedArtifacts:
    workflow.includes("editor:artifacts:smoke") &&
    artifactSmoke.includes("editor-artifacts.json") &&
    zedBuild.includes("--remap-path-prefix"),
  soakGates:
    performance.latencyMs?.["editor.editStorm"]?.p99 > 0 &&
    performance.latencyMs?.["editor.schemaChurn"]?.p99 > 0 &&
    performance.latencyMs?.["editor.projectSwitch"]?.p99 > 0 &&
    performance.memory?.["editor.lifecycleHeapGrowthMiB"]?.maximum > 0,
  publicCompatibility:
    compatibility.includes("7.1.0-dev.20260824.1") &&
    editors.includes("Supported editor features") &&
    upgrade.includes("Upgrade editor integration"),
};

const blockers = Object.entries(evidence)
  .filter(([, complete]) => !complete)
  .map(([name]) => `${name}-evidence-missing`);
if (assessment.previewApiStability !== "stable") blockers.push("typescript-preview-api-unstable");
if (assessment.verifiedCandidates.length < assessment.requiredConsecutiveCandidates) {
  blockers.push("consecutive-candidate-evidence-incomplete");
}

const experimental = new Set(release.packagePolicy?.experimental ?? []);
for (const packageName of assessment.packages) {
  if (!experimental.has(packageName) && blockers.length > 0) {
    throw new Error(`${packageName} cannot leave the experimental track while promotion blockers remain`);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      formatVersion: 1,
      decision: blockers.length === 0 ? "eligible-for-maintainer-promotion" : "remain-experimental",
      packages: assessment.packages,
      evidence,
      verifiedCandidates: assessment.verifiedCandidates.length,
      requiredConsecutiveCandidates: assessment.requiredConsecutiveCandidates,
      blockers,
    },
    null,
    2,
  )}\n`,
);
