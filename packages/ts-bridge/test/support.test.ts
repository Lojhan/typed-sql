import { describe, it, strict } from "poku";
import { TYPESCRIPT_PREVIEW_VERSION, TYPESCRIPT_SUPPORT_POLICY, typeScriptVersionSupport } from "../src/index.js";

await describe("TypeScript integration support policy", async () => {
  await it("publishes immutable exact compiler and preview versions", () => {
    strict.strictEqual(TYPESCRIPT_SUPPORT_POLICY.compiler.exactVersion, "7.0.2");
    strict.strictEqual(TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion, "7.1.0-dev.20260824.1");
    strict.strictEqual(TYPESCRIPT_PREVIEW_VERSION, TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion);
    strict.strictEqual(TYPESCRIPT_SUPPORT_POLICY.newLineAdmission, "non-blocking-canary-first");
    strict.strictEqual(TYPESCRIPT_SUPPORT_POLICY.unsupportedVersion, "reject-before-project-load");
    strict.ok(Object.isFrozen(TYPESCRIPT_SUPPORT_POLICY));
    strict.ok(Object.isFrozen(TYPESCRIPT_SUPPORT_POLICY.compiler));
    strict.ok(Object.isFrozen(TYPESCRIPT_SUPPORT_POLICY.previewBackend));
    strict.ok(Object.isFrozen(TYPESCRIPT_SUPPORT_POLICY.promotionRequirements));
  });

  await it("fails closed for untested patches, other lines, and invalid versions", () => {
    strict.strictEqual(typeScriptVersionSupport("7.0.2", "compiler"), "supported");
    strict.strictEqual(typeScriptVersionSupport("7.0.3", "compiler"), "untested-patch");
    strict.strictEqual(typeScriptVersionSupport("7.1.0-dev.20260824.1", "preview-backend"), "supported");
    strict.strictEqual(typeScriptVersionSupport("7.1.0-dev.20260825.1", "preview-backend"), "untested-patch");
    strict.strictEqual(typeScriptVersionSupport("8.0.0", "preview-backend"), "unsupported-line");
    strict.strictEqual(typeScriptVersionSupport("next", "compiler"), "unknown");
  });
});
