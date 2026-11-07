import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { describe, it, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { RunManager } from "../src/runner.js";
import { fixture } from "./helpers/fixture.js";

async function terminal(manager: RunManager, id: string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const result = manager.records.get(id)!;
    if (result.finishedAt) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Graph audit run did not settle");
}

await describe("captured dependency graph qualification", async () => {
  for (const mode of ["json", "mjs"] as const) {
    await it(`does not silently bypass the capture contract through ${mode} inputs`, async () =>
      fixture(async (directory) => {
        const configPath = join(directory, "tsconfig.json");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        config.compilerOptions.resolveJsonModule = true;
        config.compilerOptions.allowJs = true;
        config.compilerOptions.checkJs = false;
        await writeFile(configPath, JSON.stringify(config));
        let source: string;
        if (mode === "json") {
          await writeFile(join(directory, "playground/input.json"), '{"value":"checked"}');
          source = "import input from './input.json' with {type:'json'}; export async function run(){return input;}";
        } else {
          await writeFile(
            join(directory, "playground/input.mjs"),
            "export async function input(){return import('./other.mjs');}",
          );
          await writeFile(join(directory, "playground/other.mjs"), "export const value=42;");
          source = "import {input} from './input.mjs'; export async function run(){return input();}";
        }
        await writeFile(join(directory, "playground/query.ts"), source);
        const manager = new RunManager(
          await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
          new WorkspaceFiles(directory, ["playground"], ["playground"]),
          { timeoutMs: 8000, maxRows: 5, maxResultBytes: 100_000, maxConsoleBytes: 100_000 },
          "local",
          configPath,
        );
        manager.trusted = true;
        try {
          const run = manager.start({
            requestId: `graph-audit-${mode}`,
            file: "playground/query.ts",
            revision: contentHash(source),
            mode: "export",
          });
          const result = await terminal(manager, run.id);
          strict.equal(result.status, "failed", JSON.stringify(result));
          strict.equal(result.error?.code, "MODULE_GRAPH", JSON.stringify(result));
          strict.match(result.error?.message ?? "", mode === "json" ? /asset/ : /Dynamic project imports/);
          strict.deepEqual(result.results, []);
        } finally {
          await manager.close();
        }
      }));
  }
});
