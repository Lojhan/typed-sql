import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

await describe("static review tool contracts", async () => {
  await it("checks entrypoint mapping and report failure handling without installing optional tools", () => {
    const script = fileURLToPath(new URL("../../tools/static-review/review.test.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--test", script], { encoding: "utf8" });
    strict.strictEqual(result.status, 0, result.stdout + result.stderr);
    strict.strictEqual(result.signal, null);
  });
});
