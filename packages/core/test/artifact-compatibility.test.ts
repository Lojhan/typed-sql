import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import {
  assessArtifactCompatibility,
  parseArtifactCompatibilityIdentity,
  serializeArtifactCompatibilityIdentity,
} from "../src/index.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/artifact-identity-v1.json", import.meta.url), "utf8"));
const identity = parseArtifactCompatibilityIdentity(fixture);

await describe("artifact compatibility identity", async () => {
  await it("round-trips the v1 golden format and preserves optional extensions", () => {
    strict.deepStrictEqual(JSON.parse(serializeArtifactCompatibilityIdentity(identity)), fixture);
    strict.deepStrictEqual(identity.extensions, { futureOptional: { enabled: true } });
    strict.strictEqual(assessArtifactCompatibility(identity, fixture).outcome, "compatible");
  });

  await it("classifies every deterministic incompatibility outcome", () => {
    strict.strictEqual(
      assessArtifactCompatibility(identity, { ...fixture, schema: { ...fixture.schema, hash: "changed" } }).outcome,
      "requires-reanalysis",
    );
    strict.strictEqual(
      assessArtifactCompatibility(identity, {
        ...fixture,
        grammar: { ...fixture.grammar, capabilityFingerprint: "changed" },
      }).outcome,
      "requires-reintrospection",
    );
    strict.strictEqual(
      assessArtifactCompatibility(identity, {
        ...fixture,
        artifact: { ...fixture.artifact, version: "2" },
      }).outcome,
      "unsupported-target",
    );
    strict.deepStrictEqual(assessArtifactCompatibility(identity, { ...fixture, requiredFutureField: true }), {
      outcome: "corrupt-artifact",
      reasons: ["identity-invalid"],
    });
  });

  await it("rejects unknown required structure while accepting JSON extension data", () => {
    strict.throws(
      () => parseArtifactCompatibilityIdentity({ ...fixture, grammar: { ...fixture.grammar, requiredFuture: true } }),
      /unknown fields/u,
    );
    strict.throws(
      () => parseArtifactCompatibilityIdentity({ ...fixture, extensions: { invalid: Number.NaN } }),
      /finite JSON/u,
    );
  });
});
