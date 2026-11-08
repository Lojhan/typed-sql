import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { loadQueryContracts, readQueryContractManifestDigest } from "../../analysis/src/index.js";
import { execute, fixture } from "./helpers/contract-fixture.js";

async function allowOfflineOwner(directory: string): Promise<string> {
  const path = join(directory, "typed-sql.config.mjs"),
    original = await readFile(path, "utf8");
  await writeFile(
    path,
    original
      .replace('mode:"frozen"', 'mode:"offline"')
      .replace(
        'loadAnalyzer(){throw new Error("analyzer must remain cold")}',
        'loadAnalyzer:async()=>(await import("@typed-sql/postgres")).postgres()',
      ),
  );
  return original;
}
const generate = (directory: string, args: string[] = []) =>
  execute(directory, ["--queries", "--offline", ...args], "generate");
async function contents(directory: string): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of await readdir(directory, { withFileTypes: true }))
    result[entry.name] = entry.isDirectory()
      ? await contents(join(directory, entry.name))
      : await readFile(join(directory, entry.name), "utf8");
  return result;
}
await describe("durable query generation", async () => {
  await it("materializes offline rules, checks the prospective view and produces a frozen reusable closure", async () => {
    await fixture(async (directory) => {
      const original = await allowOfflineOwner(directory),
        output = join(directory, "generated/contracts");
      await rm(join(directory, "generated"), { recursive: true });
      await writeFile(join(directory, "src/value.sql"), "SELECT :id::bigint AS value");
      await writeFile(
        join(directory, "src/asset.ts"),
        'import value from "./value.sql";export const query=value({id:1n});',
      );
      await strict.rejects(generate(directory, ["--check"]), (error: unknown) => {
        strict.match((error as { stderr: string }).stderr, /export differs/u);
        return true;
      });
      await strict.rejects(lstat(output), { code: "ENOENT" });
      strict.match((await generate(directory)).stdout, /Generated 1 query contract/u);
      const contracts = await loadQueryContracts(output);
      strict.equal(contracts.length, 1);
      strict.equal(contracts[0]!.origin, "offline-rule");
      strict.equal(contracts[0]!.resultKind, "rows");
      strict.match((await generate(directory, ["--check"])).stdout, /export matches/u);
      const before = await contents(output);
      await writeFile(join(directory, "typed-sql.config.mjs"), original);
      strict.match((await execute(directory, ["--frozen"])).stdout, /2 query/u);
      strict.deepEqual(await contents(output), before);
    });
  });
  await it("does not publish or mutate a durable closure for check-only differences or TypeScript errors", async () => {
    await fixture(async (directory) => {
      await allowOfflineOwner(directory);
      const output = join(directory, "generated/contracts"),
        before = await contents(output);
      const path = join(directory, "src/query.ts"),
        source = await readFile(path, "utf8");
      await writeFile(path, source.replace("AS value", "AS changed"));
      await strict.rejects(generate(directory, ["--check"]), (error: unknown) => {
        strict.match((error as { stderr: string }).stderr, /export differs/u);
        return true;
      });
      strict.deepEqual(await contents(output), before);
      await writeFile(path, source.replace("value:bigint", "value:string"));
      await strict.rejects(generate(directory), (error: unknown) => {
        strict.match((error as { stderr: string }).stderr, /not assignable/u);
        return true;
      });
      strict.deepEqual(await contents(output), before);
      await strict.rejects(generate(directory, ["--qualification", "native-required"]));
      strict.deepEqual(await contents(output), before);
    });
  });
  await it("rejects input changes during preparation and preserves the selected manifest", async () => {
    await fixture(async (directory) => {
      const configPath = join(directory, "typed-sql.config.mjs"),
        original = await readFile(configPath, "utf8");
      const output = join(directory, "generated/contracts"),
        baseline = await readQueryContractManifestDigest(output);
      const changed = 'import {sql} from "@typed-sql/postgres/tag";export const query=sql`SELECT 2 AS changed`;';
      await writeFile(join(directory, "src/query.ts"), changed);
      const newer = changed.replace("2 AS changed", "3 AS changed");
      await writeFile(
        configPath,
        original
          .replace('mode:"frozen"', 'mode:"offline"')
          .replace(
            'loadAnalyzer(){throw new Error("analyzer must remain cold")}',
            `async loadAnalyzer(){const {writeFile}=await import("node:fs/promises");await writeFile(new URL("./src/query.ts",import.meta.url),${JSON.stringify(newer)});return (await import("@typed-sql/postgres")).postgres();}`,
          ),
      );
      await strict.rejects(generate(directory), (error: unknown) => {
        strict.match((error as { stderr: string }).stderr, /inputs changed/u);
        return true;
      });
      strict.equal(await readQueryContractManifestDigest(output), baseline);
    });
  });
  await it("supports explicit output scopes and rejects incompatible generation flags", async () => {
    await fixture(async (directory) => {
      await allowOfflineOwner(directory);
      strict.match((await generate(directory, ["--out", "other-contracts"])).stdout, /Generated 1 query/u);
      strict.equal((await loadQueryContracts(join(directory, "other-contracts"))).length, 1);
      for (const args of [
        ["--file", "src/query.ts"],
        ["--frozen"],
        ["--qualification", "invalid"],
        ["--queries=false"],
      ])
        await strict.rejects(generate(directory, args));
      await strict.rejects(execute(directory, ["--queries"]));
      await strict.rejects(execute(directory, ["--check"]));
    });
  });
});
