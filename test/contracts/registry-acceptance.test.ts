import { execFile as callback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { consumerInstallArgs } from "../helpers/consumer-install.js";

const execFile = promisify(callback);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await describe("registry-only consumer acceptance", async () => {
  await it("uses install arguments accepted by the actual pnpm CLI", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-consumer-install-options-"));
    try {
      for (const registryOnly of [true, false]) {
        await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true }));
        await execFile("pnpm", [...consumerInstallArgs(registryOnly), "--lockfile-only", "--ignore-scripts"], {
          cwd: temporary,
        });
        strict.ok((await readFile(join(temporary, "pnpm-lock.yaml"), "utf8")).includes("lockfileVersion"));
        await rm(join(temporary, "pnpm-lock.yaml"));
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

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

  await it("blocks stable publication until a coherent npm graph passes", async () => {
    const workflow = await readFile(resolve(workspace, ".github/workflows/release.yml"), "utf8");
    const gate = workflow.indexOf("Verify registry-only release candidate");
    const stableAssertion = workflow.indexOf("Assert stable release contract");
    const companionPublish = workflow.indexOf("Publish experimental companions");
    const sourceResolution = workflow.indexOf("Resolve stable registry source");
    const stablePublish = workflow.indexOf("script: pnpm release:stable");

    strict.ok(
      [gate, stableAssertion, companionPublish, sourceResolution, stablePublish].every((index) => index >= 0),
      "release workflow must retain every publication gate",
    );
    strict.ok(
      workflow
        .slice(gate, stablePublish)
        .includes("TYPED_SQL_REGISTRY_TAG: ${{ steps.stable_registry_source.outputs.tag }}"),
    );
    strict.ok(
      workflow
        .slice(gate, stablePublish)
        .includes("TYPED_SQL_REGISTRY_EXPECTED: ${{ steps.stable_registry_source.outputs.expected }}"),
    );
    strict.ok(workflow.slice(gate, stablePublish).includes("TYPED_SQL_REGISTRY_PREVIEW_TAG: next"));
    strict.ok(workflow.slice(gate, stablePublish).includes("if: inputs.channel == 'stable'"));
    strict.ok(stableAssertion < companionPublish, "stable policy must pass before companion publication");
    strict.ok(companionPublish < sourceResolution, "companion publication must precede source resolution");
    strict.ok(sourceResolution < gate, "registry source resolution must precede registry acceptance");
    strict.ok(gate < stablePublish, "registry acceptance must precede stable publication");

    const stableVerification = workflow.indexOf("Verify published stable packages from npm");
    strict.ok(workflow.slice(stableVerification).includes("TYPED_SQL_REGISTRY_TAG: latest"));
    strict.ok(workflow.slice(stableVerification).includes("TYPED_SQL_REGISTRY_PREVIEW_TAG: next"));
  });
});
