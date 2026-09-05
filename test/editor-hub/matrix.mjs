import assert from "node:assert/strict";
import { grammarCases, interfaces } from "./cases.mjs";

export const pendingInterfaces = [
  "restart-recovery",
  "multi-root",
  "tsx",
  "sql-hover",
  "sql-completion",
  "parameter-inference",
  "references",
  "rename",
  "formatting",
  "code-actions",
  "semantic-tokens",
  "packed-server-install",
  "builtin-coexistence",
];

export function buildMatrix(reports) {
  const inventory = [...interfaces, ...pendingInterfaces];
  const seen = new Set();
  for (const report of reports) {
    assert.ok(["vscode", "zed"].includes(report.editor), "unknown editor");
    assert.ok(
      grammarCases.some((spec) => spec.id === report.grammar),
      "unknown grammar",
    );
    assert.equal(report.evidence, "actual-host", "protocol evidence cannot prove host behavior");
    const key = `${report.editor}/${report.grammar}`;
    assert.ok(!seen.has(key), "duplicate host report");
    seen.add(key);
    for (const [id, check] of Object.entries(report.checks)) {
      assert.ok(inventory.includes(id), "unknown interface");
      assert.ok(["passed", "failed", "not-run"].includes(check.status), "unknown status");
    }
  }
  return {
    formatVersion: 1,
    scope: "actual-host baseline; not full grammar or editor-feature conformance",
    cells: ["vscode", "zed"].flatMap((editor) =>
      grammarCases.flatMap((spec) => {
        const report = reports.find((item) => item.editor === editor && item.grammar === spec.id);
        return inventory.map((id) => ({
          editor,
          grammar: spec.id,
          interface: id,
          status: report?.checks[id]?.status ?? "not-run",
          ...(report === undefined
            ? { reason: "No actual-host evidence supplied" }
            : {
                hostVersion: report.vscode ?? report.hostVersion,
                ...(report.checks[id] === undefined ? { reason: "Scenario not implemented" } : report.checks[id]),
              }),
        }));
      }),
    ),
  };
}
