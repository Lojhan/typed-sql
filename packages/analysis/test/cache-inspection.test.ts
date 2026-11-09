import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  createAnalysisContextScope,
  inspectAnalysisCache,
  openAnalysisCache,
  queryContractDigest,
} from "../src/index.js";
import { configuration, context, profile, request, result, schema } from "./helpers/host-fixture.js";

await describe("read-only cache inspection", async () => {
  await it("leaves absent caches and other namespaces absent, then reports indexed evidence and retirement", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cache-inspection-"));
    const input = { directory: join(temporary, "cache"), workspaceContext: queryContractDigest("inspection") };
    try {
      strict.equal((await inspectAnalysisCache(input)).status, "absent");
      await strict.rejects(lstat(input.directory), { code: "ENOENT" });
      const cache = await openAnalysisCache(input);
      const scope = createAnalysisContextScope({ profile, schema, configuration });
      const head = await cache.lookupContext(scope);
      await cache.publishContext({ token: head.token, scope, context });
      await cache.publish({ token: (await cache.lookup(request)).token, request, outcome: result });
      const file = join(input.directory, "indexes", `${input.workspaceContext}.json`);
      const before = await readFile(file, "utf8");
      const report = await inspectAnalysisCache(input);
      strict.equal(report.status, "present");
      strict.equal(report.freshness, "unverified");
      strict.deepEqual(report.outcomes, { "usable-recorded-context": 1 });
      strict.equal(
        report.indexedContracts[0]?.digest,
        result.kind === "usable-recorded-context" ? result.contract.digest : "unexpected",
      );
      strict.equal(report.contexts[0]?.status, "usable");
      strict.equal(await readFile(file, "utf8"), before);
      const names = await readdir(join(input.directory, "indexes"));
      strict.equal(
        (await inspectAnalysisCache({ ...input, workspaceContext: queryContractDigest("other") })).status,
        "absent",
      );
      strict.deepEqual(await readdir(join(input.directory, "indexes")), names);
      await cache.retireContext(context);
      const retired = await inspectAnalysisCache(input);
      strict.deepEqual(retired.indexedContracts, []);
      strict.equal(retired.outcomes["stale-context"], 1);
      strict.equal(retired.failures[0]?.code, "context-changed");
      strict.equal(retired.contexts[0]?.status, "stale");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  await it("rejects unowned, linked and corrupt cache inputs instead of initializing or repairing them", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cache-inspection-invalid-"));
    const input = { directory: join(temporary, "cache"), workspaceContext: queryContractDigest("inspection") };
    try {
      await openAnalysisCache(input);
      await symlink(input.directory, join(temporary, "linked"));
      await strict.rejects(inspectAnalysisCache({ ...input, directory: join(temporary, "linked") }), /Unsafe/u);
      const file = join(input.directory, "indexes", `${input.workspaceContext}.json`);
      await writeFile(file, "{}");
      await strict.rejects(inspectAnalysisCache(input), /cache record/u);
      strict.equal(await readFile(file, "utf8"), "{}");
      await writeFile(join(input.directory, "ownership.json"), "{}");
      await strict.rejects(inspectAnalysisCache(input), /cache record/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
