import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { openAnalysisCache, queryContractDigest } from "../../analysis/src/index.js";
import { request, result } from "../../analysis/test/helpers/host-fixture.js";
import { execute, fixture } from "./helpers/contract-fixture.js";

await describe("analysis cache commands", async () => {
  await it("reports an absent cache without creating it or loading analyzer/provider/native factories", async () => {
    await fixture(async (directory) => {
      const path = join(directory, "typed-sql.config.mjs");
      const config = await readFile(path, "utf8");
      await writeFile(
        path,
        config.replace(
          'mode:"frozen",',
          `mode:"live",cache:${JSON.stringify({ adapter: { id: "vendor/native", version: "1" }, connectionContext: queryContractDigest("cache-test") })},live:{adapter(){throw Error("native must remain cold")}},`,
        ),
      );
      const status = JSON.parse((await execute(directory, ["status", "--json"], "cache")).stdout);
      strict.equal(status.status, "absent");
      strict.equal(status.pendingRequests, "unobserved");
      strict.deepEqual(status.durableExport.indexedContractsMissing, []);
      await strict.rejects(lstat(join(directory, ".typed-sql")), { code: "ENOENT" });
      strict.match((await execute(directory, ["status"], "cache")).stdout, /freshness: unverified/u);
      strict.equal(JSON.parse((await execute(directory, ["prune", "--json"], "cache")).stdout).pruned, false);
      await strict.rejects(lstat(join(directory, ".typed-sql")), { code: "ENOENT" });
    });
  });
  await it("prunes unreachable owned objects while preserving unrelated files and validates options", async () => {
    await fixture(async (directory) => {
      const path = join(directory, "typed-sql.config.mjs");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(
          'mode:"frozen",',
          `mode:"offline",cache:${JSON.stringify({ adapter: { id: "vendor/native", version: "1" }, connectionContext: queryContractDigest("cache-test") })},`,
        ),
      );
      const root = join(directory, ".typed-sql/cache/analysis/v1");
      const cache = await openAnalysisCache({
        directory: root,
        workspaceContext: queryContractDigest({ workspace: directory, config: path }),
      });
      await cache.publish({ request, token: (await cache.lookup(request)).token, outcome: result });
      const status = JSON.parse((await execute(directory, ["status", "--json"], "cache")).stdout);
      strict.equal(status.indexedContracts.length, 1);
      strict.equal(status.durableExport.indexedContractsMissing.length, 1);
      strict.equal(status.durableExport.indexedContractsAlreadyExported, 0);
      const orphan = join(root, "queries/objects", `${queryContractDigest("orphan")}.json`);
      await writeFile(orphan, "{}");
      await mkdir(join(directory, ".typed-sql/verification"), { recursive: true });
      const unrelated = join(directory, ".typed-sql/verification/proof.json");
      await writeFile(unrelated, "keep");
      const report = JSON.parse(
        (await execute(directory, ["prune", "--retention-days", "0", "--json"], "cache")).stdout,
      );
      strict.equal(report.removed, 1);
      strict.equal(report.bytes, 2);
      strict.equal(await readFile(unrelated, "utf8"), "keep");
      await strict.rejects(lstat(orphan), { code: "ENOENT" });
      await strict.rejects(execute(directory, ["prune", "--retention-days", "-1"], "cache"));
      await strict.rejects(execute(directory, ["status", "--live"], "cache"));
      await strict.rejects(execute(directory, ["clear"], "cache"));
    });
  });
});
