import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import {
  parseNativeQueryContractEvidence,
  parseQueryContractQualification,
  queryContractDigest,
} from "../../packages/analysis/src/index.js";
import { context, request, schema } from "../../packages/analysis/test/helpers/host-fixture.js";
import { adapter, evidence, owner } from "../../packages/analysis/test/helpers/live-fixture.js";
import { unknownQuerySemantics } from "../../packages/core/src/index.js";
import { recordNativeCosts } from "../../planning/hybrid-analysis/measure-native.mjs";

const execFile = promisify(callback);

await describe("native measurement evidence retention", async () => {
  await it("retains partial native facets independently from successful qualification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-native-measurement-"));
    const previous = process.env.TYPED_SQL_NATIVE_COSTS_DIRECTORY;
    process.env.TYPED_SQL_NATIVE_COSTS_DIRECTORY = directory;
    const partial = {
      ...evidence,
      columns: evidence.columns.map((column) => ({
        ...column,
        nativeType: { status: "known" as const, value: { name: "integer", complete: false } },
        nullable: { status: "known" as const, value: true, precision: "upper-bound" as const },
      })),
    };
    const range = { start: 7, end: 8, line: 1, column: 8 };
    try {
      await recordNativeCosts({
        label: "synthetic-partial-facets",
        serverVersion: "synthetic-test-only",
        schema,
        adapter: {
          ...adapter({
            open: async () => ({ context: async () => context, describe: async () => partial, close: async () => {} }),
          }),
          inspectContext: async () => context,
        },
        candidate: request.candidate,
        analyze: () => ({
          columns: [
            {
              name: "value",
              databaseType: "integer",
              databaseTypeIsPartial: true,
              tsType: "number",
              runtimeType: "number",
              nullable: true,
              range,
            },
          ],
          parameters: [],
          diagnostics: [],
          semantics: unknownQuerySemantics(range, "Synthetic measurement fixture"),
        }),
        contribution: owner,
        policy: request.policy,
      });
      const report = JSON.parse(await readFile(join(directory, "synthetic-partial-facets.json"), "utf8"));
      strict.equal(report.formatVersion, 2);
      strict.equal(report.samples.length, 3);
      strict.equal(Object.keys(report.facetObservations).length, 1, "Repeated observations share one evidence record");
      for (const sample of report.samples) {
        const observation = report.facetObservations[sample.facetObservationDigest];
        strict.equal(queryContractDigest(observation), sample.facetObservationDigest);
        const native = parseNativeQueryContractEvidence(observation.nativeEvidence, observation.sqlLength);
        const qualification = parseQueryContractQualification(observation.qualification, native);
        strict.deepEqual(
          qualification.comparisons
            .filter((item) => item.target === "column")
            .map((item) => [item.facet, item.nativeStatus]),
          [
            ["native-type", "partial"],
            ["runtime-type", "complete"],
            ["nullability", "partial"],
          ],
        );
        strict.deepEqual(native.parameters, []);
      }
      // Synthetic report tests validation only; it is never published as native qualification.
      const input = join(directory, "aggregation-input");
      const output = join(directory, "aggregation-output");
      await mkdir(input);
      report.grammar = { id: "postgres", version: "synthetic-validator-test" };
      const reportFile = join(input, "report.json");
      await writeFile(reportFile, JSON.stringify(report));
      const aggregate = () =>
        execFile(process.execPath, [
          "planning/hybrid-analysis/summarize-native.mjs",
          "--output-directory",
          output,
          input,
        ]);
      await aggregate();
      const markdown = await readFile(join(output, "native-costs.md"), "utf8");
      strict.ok(markdown.includes("| column | partial: 1 | complete: 1 | partial: 1 |"));
      strict.ok(markdown.includes("| parameter | none in fixture | none in fixture | none in fixture |"));
      const identity = report.samples[0].facetObservationDigest;
      const observation = report.facetObservations[identity];
      observation.qualification.comparisons.find(
        (item: { target: string; facet: string }) => item.target === "column" && item.facet === "nullability",
      ).nativeStatus = "complete";
      const replacement = queryContractDigest(observation);
      delete report.facetObservations[identity];
      report.facetObservations[replacement] = observation;
      for (const sample of report.samples) sample.facetObservationDigest = replacement;
      await writeFile(reportFile, JSON.stringify(report));
      await strict.rejects(aggregate(), /Required native qualification facet unavailable/u);
      strict.equal(
        await readFile(join(output, "native-costs.md"), "utf8"),
        markdown,
        "A rehashed but false facet claim must not replace the validated report",
      );
    } finally {
      if (previous === undefined) delete process.env.TYPED_SQL_NATIVE_COSTS_DIRECTORY;
      else process.env.TYPED_SQL_NATIVE_COSTS_DIRECTORY = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
