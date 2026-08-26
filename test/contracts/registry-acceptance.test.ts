import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await describe("registry-only consumer acceptance", async () => {
  await it("exposes one command that selects registry mode", async () => {
    const rootManifest = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const fixtureManifest = JSON.parse(await readFile(resolve(workspace, "e2e/packed/package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    strict.strictEqual(rootManifest.scripts["e2e:registry"], "pnpm --filter @typed-sql/e2e-packed e2e:registry");
    strict.ok(fixtureManifest.scripts["e2e:registry"]?.includes("TYPED_SQL_CONSUMER_SOURCE=registry"));
  });

  await it("fails closed against checkout resolution and implicit drivers", async () => {
    const source = await readFile(resolve(workspace, "e2e/packed/test/packed-real.e2e.test.ts"), "utf8");

    for (const contract of [
      'process.env.TYPED_SQL_REGISTRY_TAG ?? "next"',
      'process.env.TYPED_SQL_REGISTRY_PREVIEW_TAG ?? "next"',
      'new Set(["@typed-sql/ts-bridge", "@typed-sql/language-server"])',
      "mustEventuallyRun",
      'typescript: "7.0.2"',
      '"@types/node": "24.13.3"',
      'for (const protocol of ["workspace:", "link:", "file:"])',
      "resolved outside disposable consumer",
      "resolved from the repository",
      "installed pg implicitly",
      "installed mysql2 implicitly",
      "typed-sql-language-server",
      "runtimeProjection",
      "filterParameters",
      "createDashboardServer",
      "/dashboard",
      "No schema drift detected",
    ]) {
      strict.ok(source.includes(contract), `registry acceptance lost contract: ${contract}`);
    }
  });

  await it("blocks stable publication until npm next passes", async () => {
    const workflow = await readFile(resolve(workspace, ".github/workflows/release.yml"), "utf8");
    const gate = workflow.indexOf("Verify registry-only release candidate");
    const stableAssertion = workflow.indexOf("Assert stable release contract");
    const stablePublish = workflow.indexOf("script: pnpm release:stable");

    strict.ok(gate >= 0, "release workflow must run the registry-only gate");
    strict.ok(workflow.slice(gate, stableAssertion).includes("TYPED_SQL_REGISTRY_TAG: next"));
    strict.ok(workflow.slice(gate, stableAssertion).includes("TYPED_SQL_REGISTRY_PREVIEW_TAG: next"));
    strict.ok(workflow.slice(gate, stableAssertion).includes("if: inputs.channel == 'stable'"));
    strict.ok(gate < stableAssertion, "registry gate must precede the stable release assertion");
    strict.ok(stableAssertion < stablePublish, "registry gate and assertion must precede stable publication");

    const stableVerification = workflow.indexOf("Verify published stable packages from npm");
    strict.ok(workflow.slice(stableVerification).includes("TYPED_SQL_REGISTRY_TAG: latest"));
    strict.ok(workflow.slice(stableVerification).includes("TYPED_SQL_REGISTRY_PREVIEW_TAG: next"));
  });
});
