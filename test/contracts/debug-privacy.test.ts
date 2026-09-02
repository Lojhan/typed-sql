import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, strict } from "poku";

const workspace = resolve(import.meta.dirname, "../..");

await describe("privacy-safe support bundle workflow", async () => {
  await it("requires a previewable inventory and explicit write confirmation", async () => {
    const cli = await readFile(join(workspace, "packages/cli/src/cli.ts"), "utf8");
    for (const evidence of [
      "--support-bundle-preview",
      "--confirm-support-bundle",
      "Support bundle inventory:",
      "Preview the inventory",
      "serializeSupportBundle",
    ]) {
      strict.ok(cli.includes(evidence), `CLI support bundle workflow lost ${evidence}`);
    }
    strict.ok(
      cli.indexOf("Support bundle inventory:") < cli.indexOf("await writeFile(path, serializeSupportBundle(bundle))"),
    );
  });

  await it("documents default redaction and the residual metadata boundary", async () => {
    const guide = await readFile(join(workspace, "docs/guides/support-bundles.md"), "utf8");
    for (const boundary of [
      "SQL and TypeScript source",
      "bound values",
      "database identifiers",
      "credentials",
      "connection strings",
      "paths",
      "free-form error text",
      "Inspect the generated JSON before sharing it",
    ]) {
      strict.ok(guide.includes(boundary), `support bundle guide lost ${boundary}`);
    }
  });
});
