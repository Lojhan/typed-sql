import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";
import { loadReleaseEvidencePolicy, validateReleaseEvidencePolicy } from "../../scripts/release-evidence-policy.mjs";

const workspace = resolve(import.meta.dirname, "../..");

await describe("release channel evidence requirements", async () => {
  await it("makes every later channel a strict evidence superset", async () => {
    const policy = await loadReleaseEvidencePolicy(workspace);
    for (const [earlier, later] of [
      ["development", "beta"],
      ["beta", "rc"],
      ["rc", "stable"],
    ] as const) {
      strict.ok(policy.channels[earlier].required.every((item) => policy.channels[later].required.includes(item)));
    }
  });

  await it("rejects evidence removal and duplicate requirements", async () => {
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
          channels: {
            ...source.channels,
            beta: {
              ...source.channels.beta,
              required: [...source.channels.beta.required, source.channels.beta.required[0]],
            },
          },
        }),
      /duplicate/u,
    );
  });
});
