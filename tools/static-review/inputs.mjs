/** Map published distribution entrypoints to source; do not classify public APIs as dead. */
export function sourceEntries(manifest) {
  const entries = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      const index = value.indexOf("/src/");
      if (index >= 0) entries.add(`src/${value.slice(index + 5).replace(/\.js$/, ".ts")}`);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(manifest.exports);
  visit(manifest.bin);
  if (manifest.main === "./bundle/extension.cjs") entries.add("src/extension.ts");
  if (entries.size === 0)
    throw new Error(`No source entrypoints for ${manifest.name}; configure its build mapping before scanning.`);
  return [...entries].sort();
}

// Runtime probes import compiled internals rather than package entrypoints. Keep
// their source modules as explicit boundaries; inspect script consumers before
// acting on any other unused-export suggestion.
export const compiledConsumerEntries = {
  "packages/mysql": ["src/decoding.ts", "src/parser/index.ts"],
  "packages/postgres": ["src/parser/index.ts"],
  "packages/sqlite": ["src/parser/index.ts"],
};

export function parseToolReport(tool, result) {
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`${tool} failed (status ${result.status}): ${result.stderr ?? ""}`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${tool} did not produce a JSON report: ${result.stderr ?? ""}`);
  }
  if (tool === "knip") {
    if (!Array.isArray(report.issues) || (result.status === 1 && report.issues.length === 0))
      throw new Error("Knip failed without usable findings");
  } else {
    if (!(report.summary?.unchanged + report.summary?.changed > 0) || !Array.isArray(report.diagnostics))
      throw new Error("Biome scanned no files or returned an invalid report");
  }
  return report;
}
