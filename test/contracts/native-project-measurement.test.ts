import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { queryContractDigest } from "../../packages/analysis/src/index.js";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.js";
import { writeNetworkDenialPreload } from "../helpers/network-denial.js";

const execFile = promisify(callback);
await describe("native application workload measurement", async () => {
  const probe = new DatabaseSync(":memory:");
  const statement = probe.prepare("SELECT 1");
  const supported = typeof probe.setAuthorizer === "function" && typeof statement.columns === "function";
  if ("close" in statement && typeof statement.close === "function") statement.close();
  probe.close();
  if (!supported) {
    await it.skip("Real SQLite workload qualification requires authorizer and column metadata APIs", () => {});
    return;
  }
  await it("accounts for the full corpus and reopens the qualified subset after deleting its database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-native-project-test-"));
    try {
      const output = join(directory, "report.json");
      const preload = join(directory, "deny-network.mjs");
      await writeNetworkDenialPreload(preload, "SQLite project measurement uses only its owned file", true);
      await execFile(process.execPath, [
        "--import",
        preload,
        "--import",
        "tsx",
        "planning/hybrid-analysis/measure-sqlite-commerce.mjs",
        output,
        "1,2",
      ]);
      const report = JSON.parse(await readFile(output, "utf8"));
      strict.equal(report.grammar.id, "sqlite");
      strict.equal(report.fixture.ownedDatabaseRemovedBeforeOffline, true);
      strict.ok(report.fixture.tables > 0);
      strict.equal(report.offlineNativeCalls, 0);
      strict.equal(
        report.fixtureProducer.digest,
        createHash("sha256")
          .update(await readFile(report.fixtureProducer.path))
          .digest("hex"),
      );
      strict.equal(
        report.inspections,
        report.observations.reduce(
          (sum: number, row: { contextAttempts: unknown[] }) => sum + row.contextAttempts.length,
          0,
        ),
      );
      strict.equal(
        report.acquisitions,
        report.observations.reduce((sum: number, row: { admitted: number }) => sum + row.admitted, 0),
      );
      strict.equal(
        report.toolDigest,
        createHash("sha256")
          .update(await readFile("planning/hybrid-analysis/measure-native-project.mjs"))
          .digest("hex"),
      );
      const files = commerceFiles("sqlite");
      strict.deepEqual(
        report.corpusInputs,
        Object.fromEntries(
          Object.entries(files).map(([file, source]) => [file, createHash("sha256").update(source).digest("hex")]),
        ),
      );
      const expected = Object.keys(files)
        .filter((file) => file.startsWith("queries/") && /\.(?:ts|sql)$/u.test(file))
        .sort();
      const base = report.observations[0];
      strict.deepEqual(
        [
          ...new Set([
            ...base.queries.map((query: { file: string }) => query.file),
            ...report.excluded.map((entry: { file: string }) => entry.file),
          ]),
        ].sort(),
        expected,
      );
      strict.ok(report.excluded.length > 0, "Unbounded rendering must remain accounted for");
      strict.ok(base.admitted > 0);
      strict.ok(base.counts.declined > 0, "The adapter's write restrictions must remain visible");
      for (const observation of report.observations) {
        strict.equal(observation.completeProject, false);
        strict.equal(observation.admittedSubsetComplete, true);
        strict.equal(observation.qualified, observation.admitted);
        strict.equal(observation.finiteCandidates, base.finiteCandidates * observation.copies);
        strict.equal(
          Object.values(observation.counts).reduce((sum: number, value) => sum + Number(value), 0),
          observation.finiteCandidates,
        );
        strict.ok(observation.offlineReloadAndCheckMs >= 0);
        for (const query of observation.queries) {
          if (query.status === "qualified") {
            const evidence = report.evidenceObservations[query.evidenceDigest];
            strict.ok(evidence);
            strict.equal(queryContractDigest(evidence), query.evidenceDigest);
            strict.equal(evidence.qualification.policy.mode, "native-required");
          } else strict.equal(query.evidenceDigest, undefined);
        }
      }
      const scaled = report.observations[1];
      strict.equal(scaled.qualified, base.qualified * 2);
      strict.ok(scaled.durable.bytes > base.durable.bytes);
      strict.ok(scaled.cache.bytes > base.cache.bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
