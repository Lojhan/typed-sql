import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { parseGrammarFeatureLedger } from "../../packages/conformance/src/index.js";
import {
  CONFORMANCE_VERSION,
  defineConformanceProbe,
  defineConformanceSuite,
} from "../../packages/conformance/src/v2/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await describe("conformance v2 repository integration", async () => {
  await it("can link every permanent feature identity to a validated probe", async () => {
    const ledger = parseGrammarFeatureLedger(
      JSON.parse(await readFile(join(workspace, "grammar", "features", "ledger.json"), "utf8")) as unknown,
    );
    const target = { grammar: "contract", grammarVersion: "1.0.0" } as const;
    const probes = ledger.entries.map((entry) =>
      defineConformanceProbe({
        version: CONFORMANCE_VERSION,
        id: `contract.${entry.id}.link`,
        featureId: entry.id,
        grammar: "contract",
        targets: [target],
        source: "SELECT 1",
        schemaFixture: "test/fixtures/conformance/schema.json",
        expected: [{ target: { grammarVersion: "1.0.0" }, support: "conservative" }],
      }),
    );
    const suite = defineConformanceSuite({ version: CONFORMANCE_VERSION, name: "ledger-links", probes }, ledger);
    strict.strictEqual(suite.probes.length, ledger.entries.length);
    strict.throws(
      () => defineConformanceSuite({ ...suite, probes: [{ ...probes[0]!, featureId: "missing.feature" }] }, ledger),
      /unknown feature/u,
    );
  });

  await it("exposes reproducible grammar, version, probe, and fixture-group filters", async () => {
    const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    strict.strictEqual(manifest.scripts["conformance:v2"], "node scripts/conformance-v2.mjs");
    for (const script of [
      "conformance:live",
      "conformance:live:postgres",
      "conformance:live:mysql",
      "conformance:live:sqlite",
    ]) {
      strict.ok(manifest.scripts[script] !== undefined, `missing ${script}`);
    }
    const runner = await readFile(join(workspace, "scripts", "conformance-v2.mjs"), "utf8");
    for (const option of ["--grammar", "--probe", "--database-version", "--fixture-group"]) {
      strict.ok(runner.includes(option), `conformance runner does not accept ${option}`);
    }
  });

  await it("retains redacted reports and failure reproductions from every live shard", async () => {
    const workflow = await readFile(join(workspace, ".github", "workflows", "ci.yml"), "utf8");
    for (const grammar of ["postgres", "mysql", "sqlite"]) {
      strict.ok(workflow.includes(`typed-sql-conformance-${grammar}`), `CI does not upload ${grammar} evidence`);
      const source = await readFile(
        grammar === "sqlite"
          ? join(workspace, "examples", "sqlite", "database-test", "capabilities.test.ts")
          : join(workspace, "e2e", grammar, "test", "developer-flow.e2e.test.ts"),
        "utf8",
      );
      strict.ok(source.includes(`${grammar}-reproduction.json`));
      strict.ok(source.indexOf("serializeConformanceReport") < source.lastIndexOf("strict.strictEqual(result.status"));
    }
    strict.ok((workflow.match(/retention-days: 14/gu)?.length ?? 0) >= 3);
  });
});
