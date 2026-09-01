import type { ConformanceReport } from "./types.js";

export function serializeConformanceReport(report: ConformanceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatConformanceReport(report: ConformanceReport): string {
  const lines = [
    `${report.suite}: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped, ${report.summary.quarantined} quarantined`,
    `target ${report.environment.grammar}@${report.environment.grammarVersion}${
      report.environment.databaseVersion === undefined ? "" : ` / database ${report.environment.databaseVersion}`
    }`,
  ];
  for (const result of report.results.filter(({ status }) => status !== "pass")) {
    lines.push(`${result.status.toUpperCase()} ${result.probeId} (${result.featureId})`);
    for (const layer of result.layers.filter(({ status }) => status !== "pass")) {
      lines.push(`  ${layer.layer}: ${layer.status}${layer.skipReason === undefined ? "" : ` (${layer.skipReason})`}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
