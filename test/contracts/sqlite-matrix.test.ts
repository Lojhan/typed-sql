import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execute = promisify(execFile);
const workspace = process.cwd();

await describe("SQLite support matrix", async () => {
  await it("pins every supported Node line and SQLite language boundary", async () => {
    const workflow = await readFile(join(workspace, ".github", "workflows", "ci.yml"), "utf8");
    for (const target of [
      "node-22-minimum",
      "node-22-current",
      "node-24-current",
      "node-26-current",
      "sqlite-3.39.0-minimum",
      "sqlite-3.53.4-latest",
      "sqlite-3.54.0-canary",
    ]) {
      strict.ok(workflow.includes(`label: ${target}`), `missing SQLite matrix target ${target}`);
    }
    strict.ok(workflow.includes("continue-on-error: ${{ matrix.experimental }}"));
    strict.ok(workflow.includes("b8e5b3265992350d40c4ad31efc2e6dec6256813f1d5acc8f0ea805e9f33ca2a"));
    strict.ok(workflow.includes("454e45f61c6bd75b7420e7190732dea03ce6639c63ada47bbc592f67fc340338"));
    strict.ok(workflow.includes("f7487e5c39a4b89f87d3ddee618c25c65278987b98d30ebc2a8b6bb4e277065a"));

    const packageManifest = JSON.parse(await readFile(join(workspace, "packages", "sqlite", "package.json"), "utf8"));
    strict.strictEqual(packageManifest.engines.node, ">=22.11");
    const support = await readFile(join(workspace, "packages", "sqlite", "src", "support.ts"), "utf8");
    strict.ok(support.includes('minimum: "22.13.0"'));
    strict.ok(support.includes("lines: Object.freeze([22, 24, 26]"));
  });

  await it("records redacted Node, library, capability, plan, and ledger evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-matrix-contract-"));
    const output = join(directory, "node.json");
    try {
      await execute(
        process.execPath,
        [
          join(workspace, "scripts", "sqlite-matrix-probe.mjs"),
          "--adapter",
          "node",
          "--label",
          "contract-node",
          "--output",
          output,
        ],
        { cwd: workspace },
      );
      const artifact = JSON.parse(await readFile(output, "utf8"));
      strict.strictEqual(artifact.target.label, "contract-node");
      strict.strictEqual(artifact.target.adapter, "node:sqlite");
      strict.strictEqual(artifact.target.runtimeVersion, process.version);
      strict.match(artifact.target.libraryVersion, /^3\.\d+\.\d+/u);
      strict.ok(Array.isArray(artifact.evidence.compileOptions));
      strict.match(artifact.evidence.featureLedger.revision, /^sha256:[a-f\d]{64}$/u);
      const ledger = JSON.parse(await readFile(join(workspace, "grammar", "features", "ledger.json"), "utf8"));
      const exactFeatures = ledger.entries
        .filter((entry: { dialects: { sqlite: { level: string } } }) => entry.dialects.sqlite.level === "exact")
        .map((entry: { id: string }) => entry.id)
        .sort();
      strict.deepStrictEqual(
        artifact.evidence.featureLedger.exactFeatureCoverage
          .map(({ featureId }: { featureId: string }) => featureId)
          .sort(),
        exactFeatures,
      );
      strict.deepStrictEqual(artifact.evidence.plan.unsupportedFacts, ["cost", "estimatedRows", "stableNodeShape"]);
      strict.strictEqual(artifact.evidence.plan.detail, undefined);
      strict.strictEqual(artifact.summary.fail, 0);
      strict.ok(artifact.results.every(({ status }: { status: string }) => status === "pass"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
