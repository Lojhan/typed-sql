import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import {
  TYPED_SQL_PROTOCOL_SUPPORT_POLICY,
  TYPED_SQL_PROTOCOL_VERSION,
} from "../../packages/language-server/src/index.js";
import { TYPESCRIPT_SUPPORT_POLICY } from "../../packages/ts-bridge/src/index.js";

const execute = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(testDirectory, "../..");
const rootRequire = createRequire(join(workspaceDirectory, "package.json"));
const bridgeRequire = createRequire(join(workspaceDirectory, "packages", "ts-bridge", "package.json"));

await describe("TypeScript 7 compatibility matrix", async () => {
  await it("runs the stable compiler and exact preview bridge versions", async () => {
    const stablePackage = rootRequire.resolve("typescript/package.json");
    const previewPackage = bridgeRequire.resolve("@typed-sql/typescript-preview/package.json");
    const stable = JSON.parse(await readFile(stablePackage, "utf8")) as { readonly version?: string };
    const preview = JSON.parse(await readFile(previewPackage, "utf8")) as { readonly version?: string };
    strict.strictEqual(stable.version, TYPESCRIPT_SUPPORT_POLICY.compiler.exactVersion);
    strict.strictEqual(preview.version, TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion);
    const stableOutput = await execute(process.execPath, [join(dirname(stablePackage), "bin", "tsc"), "--version"]);
    const previewOutput = await execute(process.execPath, [join(dirname(previewPackage), "bin", "tsc"), "--version"]);
    strict.strictEqual(stableOutput.stdout.trim(), `Version ${TYPESCRIPT_SUPPORT_POLICY.compiler.exactVersion}`);
    strict.strictEqual(previewOutput.stdout.trim(), `Version ${TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion}`);
  });

  await it("publishes the TypeScript admission and editor protocol compatibility policies", () => {
    strict.strictEqual(TYPESCRIPT_SUPPORT_POLICY.compiler.compatibility, "exact-tested-patch");
    strict.strictEqual(TYPESCRIPT_SUPPORT_POLICY.previewBackend.compatibility, "exact-tested-patch");
    strict.strictEqual(TYPESCRIPT_SUPPORT_POLICY.newLineAdmission, "non-blocking-canary-first");
    strict.strictEqual(TYPED_SQL_PROTOCOL_VERSION, 1);
    strict.deepStrictEqual(TYPED_SQL_PROTOCOL_SUPPORT_POLICY.acceptedVersions, [1]);
    strict.strictEqual(TYPED_SQL_PROTOCOL_SUPPORT_POLICY.legacyUnversionedClients, "accepted-as-version-1");
  });

  await it("keeps package metadata synchronized for startup checks and doctor output", async () => {
    const bridge = JSON.parse(
      await readFile(join(workspaceDirectory, "packages", "ts-bridge", "package.json"), "utf8"),
    ) as { readonly typedSql?: Readonly<Record<string, unknown>> };
    const server = JSON.parse(
      await readFile(join(workspaceDirectory, "packages", "language-server", "package.json"), "utf8"),
    ) as { readonly typedSql?: Readonly<Record<string, unknown>> };
    strict.strictEqual(
      bridge.typedSql?.typescriptPreviewVersion,
      TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion,
    );
    strict.strictEqual(bridge.typedSql?.typescriptBackend, "typescript-7.1-native-preview");
    strict.strictEqual(server.typedSql?.protocolVersion, TYPED_SQL_PROTOCOL_VERSION);
    strict.deepStrictEqual(
      server.typedSql?.acceptedProtocolVersions,
      TYPED_SQL_PROTOCOL_SUPPORT_POLICY.acceptedVersions,
    );
    strict.strictEqual(
      server.typedSql?.legacyUnversionedProtocolVersion,
      TYPED_SQL_PROTOCOL_SUPPORT_POLICY.currentVersion,
    );
    strict.strictEqual(
      server.typedSql?.typescriptPreviewVersion,
      TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion,
    );
  });

  await it("contains unstable TypeScript imports in the exact version adapter", async () => {
    const adapter = await readFile(
      join(workspaceDirectory, "packages", "ts-bridge", "src", "backends", "typescript-7.1.ts"),
      "utf8",
    );
    const wrapper = await readFile(
      join(workspaceDirectory, "packages", "ts-bridge", "src", "native-preview.ts"),
      "utf8",
    );
    strict.ok(adapter.includes("@typed-sql/typescript-preview/unstable/ast"));
    strict.ok(adapter.includes("@typed-sql/typescript-preview/unstable/async"));
    strict.ok(!wrapper.includes("@typed-sql/typescript-preview/unstable/"));
    strict.ok(wrapper.includes("TypeScript71PreviewBackend"));
  });
});
