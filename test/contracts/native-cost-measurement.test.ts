import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  parseNativeQueryContractEvidence,
  parseQueryContractQualification,
  queryContractDigest,
} from "../../packages/analysis/src/index.js";
import { context, request, schema } from "../../packages/analysis/test/helpers/host-fixture.js";
import { adapter, evidence, owner } from "../../packages/analysis/test/helpers/live-fixture.js";
import { recordNativeCosts } from "../../planning/hybrid-analysis/measure-native.mjs";

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
    } finally {
      if (previous === undefined) delete process.env.TYPED_SQL_NATIVE_COSTS_DIRECTORY;
      else process.env.TYPED_SQL_NATIVE_COSTS_DIRECTORY = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
