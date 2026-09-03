import type {
  ConformanceEnvironment,
  ConformanceProbe,
  ConformanceProbeResult,
  ConformanceReproductionBundle,
  ConformanceTarget,
  ExpectedOutcome,
} from "./types.js";

function redactOutcome(outcome: ExpectedOutcome): ExpectedOutcome {
  return Object.freeze({
    ...outcome,
    ...(outcome.rendered === undefined
      ? {}
      : {
          rendered: Object.freeze({
            ...outcome.rendered,
            values: Object.freeze(outcome.rendered.values.map(() => "[redacted]")),
          }),
        }),
    ...(outcome.decodedRows === undefined
      ? {}
      : { decodedRows: Object.freeze(outcome.decodedRows.map(() => "[redacted]")) }),
  });
}

export function createConformanceReproductionBundle(
  probe: ConformanceProbe,
  target: ConformanceTarget,
  environment: ConformanceEnvironment,
  expected: ExpectedOutcome,
  actual: ConformanceProbeResult,
): ConformanceReproductionBundle {
  const databaseArgument = target.databaseVersion === undefined ? "" : ` --database-version ${target.databaseVersion}`;
  return Object.freeze({
    formatVersion: 1,
    probeId: probe.id,
    featureId: probe.featureId,
    source: probe.source,
    schemaFixture: probe.schemaFixture,
    target,
    environment,
    expected: redactOutcome(expected),
    actual,
    command: `pnpm conformance:v2 -- --probe ${probe.id} --grammar ${probe.grammar}${databaseArgument}`,
  });
}

export function serializeConformanceReproductionBundle(bundle: ConformanceReproductionBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
