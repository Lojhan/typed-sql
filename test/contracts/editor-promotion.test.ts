import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execute = promisify(execFile);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await describe("editor promotion review", async () => {
  await it("keeps preview-backed packages experimental until every promotion gate has evidence", async () => {
    const result = await execute(process.execPath, [join(workspace, "scripts/review-editor-promotion.mjs")], {
      cwd: workspace,
    });
    const report = JSON.parse(result.stdout) as {
      readonly decision: string;
      readonly evidence: Readonly<Record<string, boolean>>;
      readonly blockers: readonly string[];
      readonly verifiedCandidates: number;
      readonly requiredConsecutiveCandidates: number;
    };
    strict.strictEqual(report.decision, "remain-experimental");
    strict.ok(Object.values(report.evidence).every(Boolean));
    strict.ok(report.blockers.includes("typescript-preview-api-unstable"));
    strict.ok(report.blockers.includes("consecutive-candidate-evidence-incomplete"));
    strict.ok(report.verifiedCandidates < report.requiredConsecutiveCandidates);
  });
});
