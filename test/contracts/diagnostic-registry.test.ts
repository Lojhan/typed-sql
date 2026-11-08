import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { diagnosticRegistry } from "../../packages/core/src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registrySource = resolve(workspace, "packages/core/src/diagnostics.ts");

await describe("stable diagnostic contract", async () => {
  await it("discovers production emitters across every package and registers their diagnostic codes", async () => {
    const emitted = new Set<string>();
    let files = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/u.test(entry.name) && file !== registrySource) {
          files++;
          for (const match of (await readFile(file, "utf8")).matchAll(/\bTSQ\d{3}\b/gu)) emitted.add(match[0]);
        }
      }
    };
    for (const entry of await readdir(join(workspace, "packages"), { withFileTypes: true }))
      if (entry.isDirectory()) await visit(join(workspace, "packages", entry.name, "src"));
    strict.ok(files > 0 && emitted.size > 0, "Production diagnostic discovery must not be empty");
    strict.deepEqual([...emitted].filter((code) => !Object.hasOwn(diagnosticRegistry, code)).sort(), []);
  });

  await it("documents every stable code, including retained codes without current emitters", async () => {
    const page = await readFile(join(workspace, "docs/reference/diagnostics.md"), "utf8");
    const documented = [...page.matchAll(/^\|\s+`(TSQ\d{3})`\s+\|/gmu)].map((match) => match[1]!);
    strict.equal(new Set(documented).size, documented.length, "Diagnostic reference contains duplicate code rows");
    strict.deepEqual(documented.sort(), Object.keys(diagnosticRegistry).sort());
  });
});
