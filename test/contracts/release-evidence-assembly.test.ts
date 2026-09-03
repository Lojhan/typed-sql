import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";
import {
  assembleReleaseEvidence,
  validateReleaseExceptions,
  writeImmutableEvidence,
} from "../../scripts/release-evidence.mjs";

const policy = {
  channels: { stable: { required: ["quality", "matrix"], stableClaimsAllowed: true } },
};
const manifest = { channel: "stable", series: "3.0.0" };
const workspace = resolve(import.meta.dirname, "../..");
const evidence = (gates: readonly string[]) => ({
  name: "ci.json",
  sha256: "abc123",
  value: { formatVersion: 1, revision: "revision-1", lane: "release", gates },
});
const exception = {
  id: "temporary-matrix-gap",
  gates: ["matrix"],
  owner: "maintainer",
  reason: "Temporary infrastructure outage",
  affectedFeatures: { "postgres.returning": "conservative" },
  expiresOn: "2026-09-30",
  removalIssue: "#123",
};

await describe("release evidence assembly", async () => {
  await it("rejects expired, unowned, and non-downgrading exceptions", () => {
    strict.throws(
      () =>
        validateReleaseExceptions(
          { formatVersion: 1, exceptions: [{ ...exception, expiresOn: "2026-08-31" }] },
          { now: new Date("2026-09-02T00:00:00Z") },
        ),
      /expired/u,
    );
    strict.throws(
      () =>
        validateReleaseExceptions(
          { formatVersion: 1, exceptions: [{ ...exception, owner: "" }] },
          { now: new Date("2026-09-02T00:00:00Z") },
        ),
      /owner/u,
    );
    strict.throws(
      () =>
        validateReleaseExceptions(
          { formatVersion: 1, exceptions: [{ ...exception, affectedFeatures: { "postgres.returning": "exact" } }] },
          { now: new Date("2026-09-02T00:00:00Z") },
        ),
      /downgrade/u,
    );
  });

  await it("keeps exceptions distinct from complete and stable evidence", () => {
    const exceptions = validateReleaseExceptions(
      { formatVersion: 1, exceptions: [exception] },
      { now: new Date("2026-09-02T00:00:00Z") },
    );
    const report = assembleReleaseEvidence({
      policy,
      manifest,
      exceptions,
      inputs: [evidence(["quality"])],
      revision: "revision-1",
    });
    strict.strictEqual(report.publishable, true);
    strict.strictEqual(report.complete, false);
    strict.strictEqual(report.stableClaimsAllowed, false);
    strict.deepStrictEqual(report.excepted, ["matrix"]);
    const complete = assembleReleaseEvidence({
      policy,
      manifest,
      exceptions,
      inputs: [evidence(["quality", "matrix"])],
      revision: "revision-1",
    });
    strict.strictEqual(complete.complete, true);
    strict.strictEqual(complete.stableClaimsAllowed, true);
  });

  await it("rejects evidence from another revision", () => {
    const exceptions = validateReleaseExceptions({ formatVersion: 1, exceptions: [] });
    strict.throws(
      () =>
        assembleReleaseEvidence({
          policy,
          manifest,
          exceptions,
          inputs: [evidence(["quality", "matrix"])],
          revision: "revision-2",
        }),
      /targets revision-1/u,
    );
  });

  await it("allows idempotent writes and rejects mutation of an existing record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-release-evidence-"));
    try {
      const path = join(directory, "evidence.json");
      await writeImmutableEvidence(path, { formatVersion: 1, complete: true });
      await writeImmutableEvidence(path, { formatVersion: 1, complete: true });
      strict.match(await readFile(path, "utf8"), /"complete": true/u);
      strict.rejects(() => writeImmutableEvidence(path, { formatVersion: 1, complete: false }), /append a new record/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("assembles same-revision evidence before every publication path", async () => {
    const workflow = await readFile(join(workspace, ".github/workflows/release.yml"), "utf8");
    const assembly = workflow.indexOf("name: Assemble complete stable evidence");
    strict.ok(assembly > 0 && assembly < workflow.indexOf("name: Publish experimental companions"));
    for (const contract of [
      "release:exceptions:check",
      "evidence_run_id",
      "--require-complete",
      "typed-sql-release-evidence-",
      "retention-days: 90",
    ]) {
      strict.ok(workflow.includes(contract), `release workflow lost ${contract}`);
    }
    const ci = await readFile(join(workspace, ".github/workflows/ci.yml"), "utf8");
    strict.ok(ci.includes("release-candidate-evidence:"));
    strict.ok(ci.includes("--gate database-matrix"));
    strict.ok(ci.includes("needs.scheduled-reliability.result == 'success'"));
  });
});
