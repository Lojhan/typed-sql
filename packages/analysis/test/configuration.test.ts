import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { DIALECT_CONTRACT_VERSION } from "../../core/src/index.js";
import { calculateSchemaHash, calculateTypePolicyHash } from "../../schema/src/index.js";
import {
  createQueryContract,
  defineAnalysisConfiguration,
  exportQueryContracts,
  loadFrozenContractView,
  type QueryContractContext,
  queryContractDigest,
} from "../src/index.js";

const hash = queryContractDigest("fixture"),
  schema = { formatVersion: 1, dialect: "vendor/config", tables: {} } as const;
const context: QueryContractContext = {
  grammar: { id: schema.dialect, version: "1" },
  profileHash: hash,
  codecHash: hash,
  interpreterHash: hash,
  schemaHash: calculateSchemaHash(schema),
  databaseContextHash: hash,
  typePolicyHash: calculateTypePolicyHash({}),
};
const identity = { profileHash: hash, codecHash: hash, interpreterHash: hash },
  qualification = { mode: "hybrid" as const, owner: { id: "vendor/rules", version: "1" }, requiredNativeFacets: [] };
const selected = { context, identity, qualification };
const profile = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: schema.dialect,
  grammarVersion: "1",
  sqlModule: "vendor/config",
  capabilities: {},
  defaultTypePolicy: {},
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (text: string) => text,
  validateSnapshot: () => schema,
};
const contract = createQueryContract({
  sql: "SELECT 1 AS value",
  context,
  origin: "offline-rule",
  valuePlan: {
    dialect: schema.dialect,
    typePolicyHash: context.typePolicyHash,
    columns: [{ name: "value", type: "number", nullable: false }],
    parameters: [],
  },
});
await describe("explicit analysis configuration", async () => {
  await it("validates sanitized cache target and adapter identities", () => {
    const cache = { connectionContext: hash, adapter: { id: "vendor/native", version: "1" } };
    strict.ok(Object.isFrozen(defineAnalysisConfiguration({ ...selected, cache }).cache));
    strict.equal(
      defineAnalysisConfiguration({ ...selected, cache: { ...cache, directory: ".typed-sql/cache/analysis/v1" } }).cache
        ?.directory,
      ".typed-sql/cache/analysis/v1",
    );
    for (const invalid of [
      null,
      [],
      {},
      { ...cache, extra: true },
      { ...cache, connectionContext: 1 },
      { ...cache, connectionContext: "invalid" },
      { ...cache, directory: 1 },
      { ...cache, directory: "" },
      { ...cache, directory: "\0" },
      { ...cache, adapter: null },
      { ...cache, adapter: [] },
      { ...cache, adapter: {} },
      { ...cache, adapter: { id: "", version: "1" } },
      { ...cache, adapter: { id: "x", version: 1 } },
      { ...cache, adapter: { id: "x", version: "x".repeat(4097) } },
    ])
      strict.throws(() => defineAnalysisConfiguration({ ...selected, cache: invalid }), /cache configuration/u);
  });
  await it("normalizes frozen data without evaluating executable declarations", () => {
    const result = defineAnalysisConfiguration(selected);
    strict.equal(result.mode, "offline");
    strict.ok(Object.isFrozen(result));
    strict.ok(Object.isFrozen(result.context));
    strict.ok(Object.isFrozen(result.identity));
    strict.equal(
      defineAnalysisConfiguration({ ...selected, mode: "live", contractsDir: "generated/contracts" }).mode,
      "live",
    );
    strict.equal(defineAnalysisConfiguration({ ...selected, mode: "frozen" }).mode, "frozen");
    for (const invalid of [
      null,
      [],
      { ...selected, extra: true },
      { ...selected, mode: "automatic" },
      { ...selected, contractsDir: "" },
      { ...selected, contractsDir: "bad\0path" },
      { ...selected, identity: null },
      { ...selected, identity: { ...identity, extra: true } },
      { ...selected, identity: { ...identity, profileHash: "bad" } },
      { ...selected, identity: { ...identity, codecHash: queryContractDigest("different") } },
      { ...selected, qualification: { ...qualification, mode: "invalid" } },
      {
        ...selected,
        get contractsDir() {
          throw Error("executable metadata");
        },
      },
    ])
      strict.throws(() => defineAnalysisConfiguration(invalid));
  });
  await it("loads a coherent frozen rule closure without an analyzer or cache and fences incompatible inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-frozen-view-"));
    try {
      await exportQueryContracts(directory, [contract]);
      const configuration = defineAnalysisConfiguration({ ...selected, mode: "frozen" });
      const view = await loadFrozenContractView({
        directory,
        profile,
        schema,
        configuration,
        loadProjectCatalogContributions() {
          throw Error("No selected catalog needs an interpreter");
        },
      });
      strict.equal(view.digest, queryContractDigest([contract.digest]));
      strict.ok(Object.isFrozen(view));
      strict.deepEqual(view.dialect.analyze("SELECT 1 AS value", schema).diagnostics, []);
      strict.equal(view.dialect.analyze("SELECT 2 AS value", schema).diagnostics[0]!.code, "TSQ406");
      const eagerProfile = {
        ...profile,
        analyze: () => {
          throw Error("must not initialize");
        },
      };
      await strict.rejects(
        () =>
          loadFrozenContractView({
            directory,
            profile: eagerProfile,
            schema,
            configuration,
          }),
        /without an eager analyzer/u,
      );
      await strict.rejects(
        () =>
          loadFrozenContractView({ directory, profile: { ...profile, grammarVersion: "2" }, schema, configuration }),
        /differs/u,
      );
      await strict.rejects(
        () =>
          loadFrozenContractView({
            directory,
            profile,
            schema: { ...schema, tables: { changed: { name: "changed", columns: {} } } },
            configuration,
          }),
        /differs/u,
      );
      await strict.rejects(
        () => loadFrozenContractView({ directory, profile, schema, typePolicy: { integer: "bigint" }, configuration }),
        /differs/u,
      );
      await strict.rejects(
        () =>
          loadFrozenContractView({
            directory,
            profile,
            schema,
            configuration: { ...configuration, qualification: { ...qualification, mode: "native-required" } },
          }),
        /qualification/u,
      );
      const rawNative = createQueryContract({
        sql: "SELECT 1 AS value",
        context,
        origin: "native-description",
        valuePlan: contract.valuePlan,
      });
      await exportQueryContracts(directory, [rawNative]);
      await strict.rejects(
        () => loadFrozenContractView({ directory, profile, schema, configuration }),
        /qualification/u,
      );
      await rm(directory, { recursive: true });
      await strict.rejects(() => loadFrozenContractView({ directory, profile, schema, configuration }), /ENOENT/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
