import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { describe, it, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { RunManager } from "../src/runner.js";
import { fixture } from "./helpers/fixture.js";

async function until(test: () => boolean) {
  const stop = Date.now() + 30000;
  while (!test()) {
    if (Date.now() > stop) throw new Error("Parent watchdog did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
await describe("parent paging watchdog", async () => {
  await it("keeps its execution deadline after a capped TypeScript result followed by a CPU loop", async () =>
    fixture(async (directory) => {
      const source = "import {show} from '@typed-sql/playground/runtime';show('partial',[1,2,3,4,5,6]);while(true){}";
      await writeFile(join(directory, "playground/loop.ts"), source);
      const manager = new RunManager(
        await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        // Include cold TypeScript startup on slower CI hosts without testing that startup itself.
        { timeoutMs: 5000, maxRows: 5, pageSize: 2, maxResultBytes: 100000, maxConsoleBytes: 100000 },
        "local",
        join(directory, "tsconfig.json"),
      );
      manager.trusted = true;
      try {
        const run = manager.start({
          requestId: "partial-result-cpu-loop",
          file: "playground/loop.ts",
          revision: contentHash(source),
          mode: "file",
        });
        await until(() => run.finishedAt !== undefined);
        strict.equal(run.results[0]?.paging?.complete, false, JSON.stringify(run));
        strict.equal(run.status, "outcome-unknown", JSON.stringify(run));
        strict.ok((run.timings.workerMs ?? 0) < 10000, "parent terminates CPU loop despite incomplete paging metadata");
      } finally {
        await manager.close();
      }
    }));
  await it("rearms execution watchdog after demand even if a custom adapter ignores cancellation", async () =>
    fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      const original = await readFile(config, "utf8");
      await writeFile(
        config,
        original.replace(
          "query:async request=>({columns:[{name:'id'}],rows:[[request.values[0]??42]],truncated:false})",
          "rowStreaming:true,query:async request=>{await request.onRows({columns:[{name:'id'}],rows:[[1],[2]],truncated:false});return new Promise(()=>{})}",
        ),
      );
      const source = "select id from public.accounts";
      await writeFile(join(directory, "playground/query.sql"), source);
      const manager = new RunManager(
        await loadConfig({ file: config }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        { timeoutMs: 5000, pageSize: 2, cursorIdleMs: 5000, maxResultBytes: 100000, maxConsoleBytes: 100000 },
        "local",
        join(directory, "tsconfig.json"),
      );
      try {
        const run = manager.start({
          requestId: "uncooperative-cursor-adapter",
          file: "playground/query.sql",
          revision: contentHash(source),
          mode: "sql",
        });
        await until(() => run.results.length > 0 || run.finishedAt !== undefined);
        strict.equal(run.status, "running", JSON.stringify(run));
        const page = (await manager.page(run.id, run.results[0]!.paging!.id, 1)) as { hasPage: boolean };
        await until(() => run.finishedAt !== undefined);
        strict.equal(page.hasPage, false);
        strict.equal(run.status, "outcome-unknown", JSON.stringify(run));
        strict.ok((run.timings.workerMs ?? 0) < 10000);
      } finally {
        await manager.close();
      }
    }));
});
