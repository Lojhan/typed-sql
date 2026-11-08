import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  createAnalysisContextScope,
  defineAnalysisConfiguration,
  exportQueryContracts,
  loadFrozenContractView,
  loadQueryContractContext,
  loadQueryContracts,
  openAnalysisCache,
  queryContractDigest,
  queryContractManifestDigest,
  selectOfflineAnalysisContext,
} from "../src/index.js";
import { configuration, context, contract, profile, schema } from "./helpers/host-fixture.js";
import { hash } from "./helpers/live-fixture.js";

const { context: _context, ...automatic } = configuration;
const input = { profile, schema, configuration: automatic };
const scope = createAnalysisContextScope(input);
async function temporary(test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-context-selection-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await describe("automatic recorded context selection", async () => {
  await it("retains retirement evidence for a durable context without publishing it as a usable target head", async () => {
    await temporary(async (directory) => {
      const cache = await openAnalysisCache({ directory, workspaceContext: hash });
      const initial = await cache.lookupContext(scope, context);
      strict.equal(initial.recorded, undefined);
      await cache.retireContext(context);
      strict.equal((await cache.lookupContext(scope)).recorded, undefined);
      const retired = await cache.lookupContext(scope, context);
      strict.equal(retired.recorded?.status, "stale");
      strict.deepEqual(retired.recorded?.context, context);
      strict.equal(await cache.areTokensCurrent([initial.token]), false);
      await strict.rejects(
        cache.lookupContext(scope, { ...context, profileHash: queryContractDigest("wrong-scope") }),
        /Observed context/u,
      );
    });
  });
  await it("keeps compatibility identities independently configured and permits unobserved hybrid rules only", async () => {
    strict.equal(defineAnalysisConfiguration(automatic).context, undefined);
    const offline = await selectOfflineAnalysisContext({
      ...input,
      configuration: { ...automatic, qualification: { ...automatic.qualification, mode: "hybrid" } },
    });
    strict.equal(offline.schemaHash, context.schemaHash);
    strict.notEqual(offline.databaseContextHash, context.databaseContextHash);
    strict.deepEqual(await selectOfflineAnalysisContext({ ...input, configuration }), context);
    await strict.rejects(selectOfflineAnalysisContext(input), /No recorded target context/u);
    const { cache: _cache, ...withoutTarget } = automatic;
    strict.throws(() => defineAnalysisConfiguration(withoutTarget), /explicit cache target/u);
  });
  await it("binds durable selection to a target and semantic scope, including an empty closure", async () => {
    await temporary(async (directory) => {
      const selection = { scope, context };
      const digest = await exportQueryContracts(directory, [contract], { selection });
      strict.equal(digest, queryContractManifestDigest([contract], { selection }));
      strict.deepEqual(await loadQueryContractContext(directory, scope), context);
      strict.deepEqual(await selectOfflineAnalysisContext({ ...input, directory }), context);
      const frozen = await loadFrozenContractView({
        ...input,
        directory,
        configuration: { ...automatic, mode: "frozen" },
      });
      strict.deepEqual(frozen.context, context);
      strict.equal(frozen.contracts.length, 1);
      await strict.rejects(
        loadFrozenContractView({
          ...input,
          directory,
          configuration: {
            ...automatic,
            context: { ...context, databaseContextHash: queryContractDigest("wrong pin") },
          },
        }),
        /Pinned context/u,
      );
      await strict.rejects(
        loadQueryContractContext(directory, { ...scope, connectionContext: queryContractDigest("other target") }),
        /target scope/u,
      );
      strict.equal(
        await loadQueryContractContext(directory, { ...scope, schemaHash: queryContractDigest("updated schema") }),
        undefined,
      );
      await strict.rejects(
        exportQueryContracts(directory, [contract], {
          selection: { scope, context: { ...context, databaseContextHash: queryContractDigest("other epoch") } },
        }),
        /selected target context/u,
      );
      await exportQueryContracts(directory, [], { selection });
      strict.deepEqual(await loadQueryContracts(directory), []);
      strict.deepEqual((await loadFrozenContractView({ ...input, directory })).context, context);
      await exportQueryContracts(directory, [contract]);
      strict.equal(await loadQueryContractContext(directory, scope), undefined);
      await strict.rejects(loadFrozenContractView({ ...input, directory }), /declared durable target/u);
    });
  });
  await it("prefers current scoped cache observations and refuses known stale fallback", async () => {
    await temporary(async (directory) => {
      const durable = join(directory, "contracts");
      await exportQueryContracts(durable, [contract], { selection: { scope, context } });
      const cache = await openAnalysisCache({ directory: join(directory, "cache"), workspaceContext: hash });
      const next = { ...context, databaseContextHash: queryContractDigest("new epoch") };
      await cache.publishContext({
        token: (await cache.lookupContext(scope)).token,
        scope,
        context: next,
        previousContext: context,
      });
      strict.deepEqual(await selectOfflineAnalysisContext({ ...input, directory: durable, cache }), next);
      await cache.retireContext(next);
      await strict.rejects(selectOfflineAnalysisContext({ ...input, directory: durable, cache }), /context is stale/u);
    });
  });
});
