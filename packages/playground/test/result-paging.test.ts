import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { describe, it, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { RunManager } from "../src/runner.js";
import { decodeValue } from "../src/values.js";
import { fixture } from "./helpers/fixture.js";

await describe("retained result pages", async () => {
  await it("retains all materialized rows beyond 500 in immutable bounded pages", async () =>
    fixture(async (directory) => {
      const source = "export function run(){return Array.from({length:1203},(_,id)=>({id}));}";
      await writeFile(join(directory, "playground/query.ts"), source);
      const manager = new RunManager(
        await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        { timeoutMs: 8000, pageSize: 137, maxResultBytes: 100_000, maxConsoleBytes: 100_000 },
        "local",
        join(directory, "tsconfig.json"),
      );
      manager.trusted = true;
      try {
        const run = manager.start({
          requestId: "retained-paged-result",
          file: "playground/query.ts",
          revision: contentHash(source),
          mode: "export",
        });
        const until = Date.now() + 20000;
        while (!run.finishedAt && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
        strict.equal(run.status, "succeeded", JSON.stringify(run));
        const result = run.results[0]!;
        strict.equal(result.paging?.rowCount, 1203);
        strict.equal(result.paging?.complete, true);
        strict.equal(result.paging?.source, "materialized");
        strict.equal((decodeValue(result.value) as unknown[]).length, 137);
        const ids: number[] = [];
        for (let page = 0; page < result.paging!.pageCount; page++) {
          const response = (await manager.page(run.id, result.paging!.id, page)) as {
            value: Parameters<typeof decodeValue>[0];
            nextPage: number | null;
          };
          ids.push(...(decodeValue(response.value) as { id: number }[]).map((row) => row.id));
        }
        strict.deepEqual(
          ids,
          Array.from({ length: 1203 }, (_, i) => i),
        );
        strict.equal(
          JSON.stringify(await manager.page(run.id, result.paging!.id, 0)),
          JSON.stringify(await manager.page(run.id, result.paging!.id, 0)),
          "captured pages are repeatable without reexecution",
        );
        strict.ok((run.timings.totalMs ?? 0) > 0);
        await manager.close();
        await strict.rejects(
          () => manager.page(run.id, result.paging!.id, 1),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "RUN_EXPIRED" &&
            "status" in error &&
            error.status === 410,
        );
      } finally {
        await manager.close();
      }
    }));
});
