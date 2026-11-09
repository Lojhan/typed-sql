import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { parseGrammarFeatureLedger } from "../../packages/conformance/src/index.js";
import {
  CONFORMANCE_VERSION,
  defineConformanceProbe,
  defineConformanceSuite,
} from "../../packages/conformance/src/v2/index.js";

const execute = promisify(execFile);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await describe("conformance v2 repository integration", async () => {
  await it("keeps local reusable workflows callable and root CI commands executable", async () => {
    const ci = await readFile(join(workspace, ".github/workflows/ci.yml"), "utf8");
    for (const match of ci.matchAll(/uses: \.\/(\.github\/workflows\/[^\s]+\.yml)/gu)) {
      const called = await readFile(join(workspace, match[1]!), "utf8");
      strict.match(called, /^ {2}workflow_call:/mu, `${match[1]} cannot be called by CI`);
    }
    const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
    for (const match of ci.matchAll(/\bpnpm ([a-z][\w:-]*)/gu)) {
      const command = match[1]!;
      strict.ok(
        ["install", "exec", "audit", "dlx"].includes(command) || Object.hasOwn(manifest.scripts, command),
        `CI calls missing root command ${command}`,
      );
    }
  });

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

  await it("executes filtered native static corpora through published entrypoints", async () => {
    const help = await execute(process.execPath, ["scripts/conformance-v2.mjs", "--help"], { cwd: workspace });
    for (const grammar of ["sqlserver", "duckdb"]) strict.ok(help.stdout.includes(grammar));
    for (const [grammar, probe] of [
      ["sqlserver", "sqlserver.maturity.integer-division"],
      ["duckdb", "duckdb.native.struct"],
      ["sqlserver", "sqlserver.parameters.ordered"],
      ["duckdb", "duckdb.parameters.ordered"],
      ["sqlserver", "sqlserver.diagnostics.utf16"],
      ["duckdb", "duckdb.diagnostics.utf16"],
    ] as const) {
      const child = await execute(process.execPath, ["--import", "tsx", "scripts/native-conformance-v2.ts", grammar], {
        cwd: workspace,
        env: { ...process.env, TYPED_SQL_CONFORMANCE_PROBE: probe, TYPED_SQL_CONFORMANCE_FIXTURE_GROUP: "native" },
      });
      strict.match(child.stdout, /static maintainer corpus: 1 passed, 0 failed/u);
      const report = JSON.parse(
        await readFile(join(workspace, "artifacts/conformance", `${grammar}-static.json`), "utf8"),
      ) as {
        environment: { capabilities: { staticMaintainerCorpus: boolean; publishedEntrypoints: boolean } };
        results: { probeId: string; layers: { layer: string; status: string }[] }[];
      };
      strict.deepEqual(report.environment.capabilities, { staticMaintainerCorpus: true, publishedEntrypoints: true });
      strict.equal(report.results.length, 1);
      strict.equal(report.results[0]?.probeId, probe);
      const required = probe.includes(".diagnostics.")
        ? ["resolve"]
        : probe.includes(".parameters.")
          ? ["resolve", "compile", "render"]
          : ["resolve", "compile"];
      for (const layer of required)
        strict.equal(report.results[0]?.layers.find((entry) => entry.layer === layer)?.status, "pass");
      strict.ok(!JSON.stringify(report).includes('"tsType":"any"'));
    }
  });
  await it("rejects unqualified native live targets before build or database dispatch", async () => {
    for (const [grammar, version, pattern] of [
      ["sqlserver", "17", /matching TYPED_SQL_SQLSERVER_MAJOR/u],
      ["duckdb", "1.4.0", /exact engine 1.5.6 or 2.0.0/u],
    ] as const) {
      await strict.rejects(
        execute(process.execPath, ["scripts/conformance-v2.mjs", "--grammar", grammar, "--database-version", version], {
          cwd: workspace,
          env: {
            ...process.env,
            TYPED_SQL_SQLSERVER_MAJOR: "",
            TYPED_SQL_SQLSERVER_BUILD: "",
            TYPED_SQL_SQLSERVER_PASSWORD: "",
          },
        }),
        (error: unknown) => {
          const failure = error as { stderr?: string; stdout?: string };
          return pattern.test(failure.stderr ?? "") && !(failure.stdout ?? "").includes("build");
        },
      );
    }
  });
  await it("retains the committed SQL Server and DuckDB native qualification artifact shards", async () => {
    const sqlWorkflow = await readFile(join(workspace, ".github/workflows/sqlserver-qualification.yml"), "utf8");
    const ci = await readFile(join(workspace, ".github/workflows/ci.yml"), "utf8");
    strict.ok(sqlWorkflow.includes("qualify:adapter"));
    strict.ok(sqlWorkflow.includes("path: artifacts/sqlserver"));
    strict.ok(sqlWorkflow.includes("retention-days: 14"));
    strict.ok(ci.includes("duckdb-packed-"));
    strict.ok(ci.includes("path: artifacts/duckdb/packed"));
    const sql = await readFile(join(workspace, "e2e/sqlserver/adapter-probe.mjs"), "utf8");
    strict.ok(sql.includes("process.env.TYPED_SQL_SQLSERVER_BUILD"));
    strict.ok(sql.includes("await writeFile(output, JSON.stringify(evidence"));
    const finalizationStart = sql.lastIndexOf("\n} finally {");
    strict.ok(finalizationStart >= 0, "Native adapter evidence needs an outer failure finalizer");
    const finalization = sql.slice(finalizationStart).split("\n}\n")[0]!;
    strict.ok(finalization.includes('await mkdir(resolve(output, "..")'));
    strict.ok(finalization.includes("await writeFile(output, JSON.stringify(evidence"));
    const duck = await readFile(join(workspace, "e2e/duckdb/test.mjs"), "utf8");
    strict.ok(duck.includes("DUCKDB_SUPPORT_POLICY.qualifiedEngines"));
    strict.ok(duck.includes("DUCKDB_SUPPORT_POLICY.nodeApi[version]"));
    strict.ok(duck.includes("-failure.log"));
    const runner = await readFile(join(workspace, "scripts/conformance-v2.mjs"), "utf8");
    for (const branch of ["sqlserver-live-", "duckdb-live-", "adapter-probe.mjs", "ledger-capabilities"])
      strict.ok(runner.includes(branch));
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
