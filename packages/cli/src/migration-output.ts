function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Human output stays compact; JSON retains the full versioned evidence envelope. */
export function writeMigrationOutput(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const data = record(value);
  if (!data) {
    process.stdout.write(`${String(value)}\n`);
    return;
  }
  const lines: string[] = [];
  const target = record(data.identity ?? data.target);
  if (target) lines.push(`Target: ${String(target.database)} (${String(target.server)})`);
  if (data.kind === "typed-sql-migration-status") {
    const history = record(data.history),
      applied = Array.isArray(history?.applied) ? history.applied : [],
      pending = Array.isArray(data.pending) ? data.pending : [];
    lines.push(`Schema: ${String(data.driftState)}; ${applied.length} applied, ${pending.length} pending`);
    for (const item of applied) {
      const entry = record(item);
      if (entry)
        lines.push(
          `  applied ${String(entry.id)} ${String(entry.appliedAt ?? "time unknown")} (${String(entry.origin)})`,
        );
    }
    for (const id of pending) lines.push(`  pending ${String(id)}`);
    for (const item of Array.isArray(data.drift) ? data.drift : []) {
      const change = record(item);
      if (change) lines.push(`  drift ${String(change.kind)} ${String(change.object)}`);
    }
    for (const item of Array.isArray(data.diagnostics) ? data.diagnostics : []) {
      const diagnostic = record(item);
      if (diagnostic) lines.push(`  ${String(diagnostic.code)}: ${String(diagnostic.message)}`);
    }
    if (Array.isArray(data.resolutionEvidence) && data.resolutionEvidence.length)
      lines.push("Use status --json for the inspected-resolution evidence template.");
  } else if (data.kind === "typed-sql-migration-report") {
    lines.push(`Plan: ${String(data.hash)} (${String(data.direction)})`);
    for (const item of Array.isArray(data.migrations) ? data.migrations : []) {
      const migration = record(item);
      if (migration)
        lines.push(
          `  ${String(migration.id)}: ${String(migration.operations)} operation(s), transaction=${String(migration.transaction)}`,
        );
    }
    lines.push("Live checks are re-evaluated under the target lock; deferred checks run at their declared phase.");
    if (data.bundle !== undefined) lines.push(`Private executable bundle: ${String(data.bundle)}`);
  } else if (data.kind === "typed-sql-migration-verification") {
    const compatibility = record(data.compatibility),
      summary = record(compatibility?.summary);
    lines.push(`Compatibility: ${String(summary?.error ?? 0)} errors, ${String(summary?.warning ?? 0)} warnings`);
    for (const item of Array.isArray(compatibility?.assessments) ? compatibility.assessments : []) {
      const assessment = record(item);
      if (assessment)
        lines.push(
          `  ${String(assessment.severity)} ${String(assessment.direction)} ${String(assessment.classification)}: ${String(assessment.reason)}`,
        );
    }
    lines.push(`Report: ${String(data.reportFile)}`);
  } else {
    if (data.state !== undefined) lines.push(`Migration ${String(data.state)}`);
    if (data.directory !== undefined) lines.push(`Directory: ${String(data.directory)}`);
    if (data.file !== undefined) lines.push(`File: ${String(data.file)}`);
    for (const id of Array.isArray(data.migrations) ? data.migrations : [])
      lines.push(`  ${typeof id === "string" ? id : String(record(id)?.id ?? "")}`);
    if (data.compatibility === "not-evaluated")
      lines.push("Replay completed; application compatibility has not been evaluated.");
    if (data.beforeFile !== undefined) lines.push(`Before snapshot: ${String(data.beforeFile)}`);
    if (data.afterFile !== undefined) lines.push(`After snapshot: ${String(data.afterFile)}`);
  }
  for (const item of Array.isArray(data.findings) ? data.findings : []) {
    const finding = record(item);
    if (finding && finding.status !== "passed")
      lines.push(
        `  ${String(finding.severity)} ${String(finding.id)} (${String(finding.status)}): ${String(finding.message)}`,
      );
  }
  if (data.next !== undefined) lines.push(String(data.next));
  process.stdout.write(`${lines.join("\n")}\n`);
}
