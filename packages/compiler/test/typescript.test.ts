import { describe, it, strict } from "poku";
import {
  assertTypeScriptCompilerVersion,
  TYPESCRIPT_COMPILER_SUPPORT_POLICY,
  TypeScriptCompilerCompatibilityError,
  typeScriptCompilerVersionSupport,
} from "../src/index.js";

await describe("TypeScript compiler startup compatibility", async () => {
  await it("accepts only the exact tested compiler patch", () => {
    strict.strictEqual(TYPESCRIPT_COMPILER_SUPPORT_POLICY.exactVersion, "7.0.2");
    strict.strictEqual(typeScriptCompilerVersionSupport("7.0.2"), "supported");
    strict.strictEqual(typeScriptCompilerVersionSupport("7.0.3"), "untested-patch");
    strict.strictEqual(typeScriptCompilerVersionSupport("7.1.0"), "unsupported-line");
    strict.strictEqual(typeScriptCompilerVersionSupport("next"), "unknown");
    strict.doesNotThrow(() => assertTypeScriptCompilerVersion("7.0.2"));
    strict.throws(
      () => assertTypeScriptCompilerVersion("7.0.3"),
      (error: unknown) =>
        error instanceof TypeScriptCompilerCompatibilityError &&
        error.code === "TYPESCRIPT_COMPILER_VERSION_UNSUPPORTED" &&
        error.message.includes("Install the exact supported TypeScript patch"),
    );
  });
});
