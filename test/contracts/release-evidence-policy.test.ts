import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";
import { loadReleaseEvidencePolicy, validateReleaseEvidencePolicy } from "../../scripts/release-evidence-policy.mjs";

const workspace = resolve(import.meta.dirname, "../..");

await describe("release channel and promotion evidence policy", async () => {
  await it("makes every later channel a strict evidence superset", async () => {
    const policy = await loadReleaseEvidencePolicy(workspace);
    for (const [earlier, later] of [
      ["development", "beta"],
      ["beta", "rc"],
      ["rc", "stable"],
    ] as const) {
      strict.ok(policy.channels[earlier].required.every((item) => policy.channels[later].required.includes(item)));
    }
    strict.strictEqual(policy.channels.stable.stableClaimsAllowed, true);
    strict.strictEqual(policy.channels.rc.stableClaimsAllowed, false);
  });

  await it("requires complete promotion and support-target evidence maps", async () => {
    const policy = await loadReleaseEvidencePolicy(workspace);
    strict.deepStrictEqual(Object.keys(policy.promotion).sort(), ["editor", "grammar", "package"]);
    for (const required of ["security-review", "known-limitations", "rollback-retry-procedure"]) {
      strict.ok(Object.values(policy.promotion).every((evidence) => evidence.includes(required)));
    }
    strict.ok(policy.supportTargetChange.includes("support-policy"));
    strict.ok(policy.supportTargetChange.includes("differential-matrix"));
  });

  await it("rejects evidence removal, duplicates, and premature stable claims", async () => {
    const source = JSON.parse(await readFile(join(workspace, "release-evidence-policy.json"), "utf8"));
    strict.throws(
      () =>
        validateReleaseEvidencePolicy({
          ...source,
          channels: { ...source.channels, beta: { ...source.channels.beta, required: ["quality"] } },
        }),
      /cannot remove/u,
    );
    strict.throws(
      () =>
        validateReleaseEvidencePolicy({
          ...source,
          supportTargetChange: [...source.supportTargetChange, source.supportTargetChange[0]],
        }),
      /duplicate/u,
    );
  });
});
