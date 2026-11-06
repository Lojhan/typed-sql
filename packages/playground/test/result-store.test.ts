import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { ResultSpool } from "../src/result-store.js";
import { decodeValue } from "../src/values.js";

await describe("private captured page storage", async () => {
  await it("bounds disk across result sets and reports quota failure instead of truncating", async () => {
    const root = await mkdtemp(join(tmpdir(), "result-spool-"));
    try {
      const budget = { bytes: 0 };
      const a = new ResultSpool(root, 200, 1000, "materialized", 100, budget);
      a.append([1, 2, 3], 3);
      strict.deepEqual(decodeValue(JSON.parse(await readFile(join(root, a.id, "0.json"), "utf8"))), [1, 2, 3]);
      strict.equal((await stat(join(root, a.id, "0.json"))).mode & 0o777, 0o600);
      const b = new ResultSpool(root, 200, 1000, "materialized", 100, budget);
      strict.throws(() => b.append(["x".repeat(80)], 1), /disk quota/);
      strict.equal(b.pageCount, 0);
      strict.equal(a.metadata(false).complete, false);
      strict.equal(a.rowCount, 3);
      a.finalizeFirst({ rows: [1, 2, 3], command: "INSERT", affectedRows: 3 });
      const final = decodeValue(JSON.parse(await readFile(join(root, a.id, "0.json"), "utf8"))) as {
        command: string;
        affectedRows: number;
      };
      strict.equal(final.command, "INSERT");
      strict.equal(final.affectedRows, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
