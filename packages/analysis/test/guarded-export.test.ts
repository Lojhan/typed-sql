import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import {
  createContractDialect,
  createQueryContract,
  exportQueryContracts,
  loadQueryContracts,
  queryContractDigest,
  queryContractManifestDigest,
  readQueryContractManifestDigest,
} from "../src/index.js";
import { context, contract, profile, schema } from "./helpers/host-fixture.js";

async function temporary(test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-guarded-export-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await describe("guarded durable publication", async () => {
  await it("fences two independent exporter processes against the same reviewed baseline", async () => {
    await temporary(async (directory) => {
      const before = await exportQueryContracts(directory, [contract]);
      const alternative = createQueryContract({
        sql: "SELECT 2 AS value",
        context,
        origin: "offline-rule",
        valuePlan: contract.valuePlan,
      });
      const script = `import {exportQueryContracts} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
        await exportQueryContracts(process.argv[1],JSON.parse(process.argv[2]),{expectedManifestDigest:process.argv[3]});`;
      const run = (contracts: readonly unknown[]) =>
        promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          directory,
          JSON.stringify(contracts),
          before,
        ]);
      const results = await Promise.allSettled([run([alternative]), run([])]);
      strict.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      strict.match(String(results.find((result) => result.status === "rejected")?.reason), /manifest changed/u);
      strict.notEqual(await readQueryContractManifestDigest(directory), before);
      await loadQueryContracts(directory);
    });
  });
  await it("compares exact manifests and rejects competing replacements", async () => {
    await temporary(async (directory) => {
      const first = await exportQueryContracts(directory, [contract], { expectedManifestDigest: null });
      strict.equal(first, queryContractManifestDigest([contract, contract]));
      strict.equal(await readQueryContractManifestDigest(directory), first);
      const alternative = createQueryContract({
        sql: "SELECT 2 AS value",
        context,
        origin: "offline-rule",
        valuePlan: contract.valuePlan,
      });
      const results = await Promise.allSettled([
        exportQueryContracts(directory, [alternative], { expectedManifestDigest: first }),
        exportQueryContracts(directory, [], { expectedManifestDigest: first }),
      ]);
      strict.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const failed = results.find((result) => result.status === "rejected");
      strict.match(String(failed?.reason), /manifest changed/u);
      strict.notEqual(await readQueryContractManifestDigest(directory), first);
      await strict.rejects(
        exportQueryContracts(directory, [], { expectedManifestDigest: "invalid" }),
        /expected.*digest/u,
      );
    });
  });
  await it("leaves the old closure intact when a final input fence fails", async () => {
    await temporary(async (directory) => {
      const before = await exportQueryContracts(directory, [contract]);
      let called = 0;
      await strict.rejects(
        exportQueryContracts(directory, [], {
          expectedManifestDigest: before,
          beforeCommit: async () => {
            called++;
            throw Error("project inputs changed");
          },
        }),
        /inputs changed/u,
      );
      strict.equal(called, 1);
      strict.equal(await readQueryContractManifestDigest(directory), before);
      strict.equal((await loadQueryContracts(directory)).length, 1);
      strict.ok(!(await readdir(directory)).some((name) => name.endsWith(".tmp") || name === ".publication.lock"));
      await exportQueryContracts(directory, [], {
        expectedManifestDigest: before,
        beforeCommit: async () => {
          called++;
        },
      });
      strict.equal(called, 2);
      strict.deepEqual(await loadQueryContracts(directory), []);
    });
  });
  await it("does not overwrite a manifest replaced by a noncooperating writer during the final fence", async () => {
    await temporary(async (directory) => {
      const before = await exportQueryContracts(directory, [contract]);
      await strict.rejects(
        exportQueryContracts(directory, [], {
          expectedManifestDigest: before,
          beforeCommit: async () => {
            const body = { formatVersion: 1, contexts: [], queries: [] };
            await writeFile(
              join(directory, "manifest.json"),
              JSON.stringify({ ...body, digest: queryContractDigest(body) }),
            );
          },
        }),
        /manifest changed/u,
      );
      strict.deepEqual(await loadQueryContracts(directory), []);
    });
  });
  await it("rejects unsafe artifact files and publication locks", async () => {
    await temporary(async (directory) => {
      await writeFile(join(directory, ".publication.lock"), "foreign");
      await strict.rejects(exportQueryContracts(directory, [contract]), /Unsafe.*lock/u);
      await rm(join(directory, ".publication.lock"));
      await exportQueryContracts(directory, [contract]);
      const manifest = await readFile(join(directory, "manifest.json"), "utf8");
      await writeFile(join(directory, "saved.json"), manifest);
      await rm(join(directory, "manifest.json"));
      await symlink(join(directory, "saved.json"), join(directory, "manifest.json"));
      await strict.rejects(loadQueryContracts(directory), /regular files/u);
      await rm(join(directory, "manifest.json"));
      await writeFile(join(directory, "manifest.json"), Buffer.from([0xff]));
      await strict.rejects(readQueryContractManifestDigest(directory), /encoded data/u);
    });
  });
});
await describe("recorded result kinds", async () => {
  await it("preserves offline command/row identity and rejects inconsistent native descriptors", () => {
    for (const resultKind of ["rows", "command"] as const) {
      const selected = createQueryContract({
        sql: "SELECT 1",
        context,
        origin: "offline-rule",
        resultKind,
        valuePlan: { ...contract.valuePlan, columns: [], parameters: [] },
      });
      strict.equal(
        createContractDialect({ profile, context, contracts: [selected] }).analyze("SELECT 1", schema).resultKind,
        resultKind,
      );
    }
    strict.throws(
      () =>
        createQueryContract({
          sql: "SELECT 1",
          context,
          origin: "offline-rule",
          resultKind: "invalid" as "rows",
          valuePlan: contract.valuePlan,
        }),
      /result kind/u,
    );
    strict.throws(
      () =>
        createQueryContract({
          sql: "SELECT 1",
          context,
          origin: "offline-rule",
          resultKind: "command",
          valuePlan: contract.valuePlan,
        }),
      /result kind/u,
    );
    strict.throws(
      () =>
        createQueryContract({
          sql: "SELECT 1",
          context,
          origin: "native-description",
          resultKind: "rows",
          valuePlan: { ...contract.valuePlan, columns: [], parameters: [] },
          nativeEvidence: { ...contract.nativeEvidence!, resultKind: "command", columns: [], parameters: [] },
        }),
      /Native contract evidence/u,
    );
  });
});

import { execFile } from "node:child_process";
