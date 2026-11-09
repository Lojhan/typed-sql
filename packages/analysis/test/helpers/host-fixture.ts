import { DIALECT_CONTRACT_VERSION } from "../../../core/src/index.js";
import { calculateSchemaHash, calculateTypePolicyHash } from "../../../schema/src/index.js";
import { createNativeLiveAnalysisRunner, parseStaticQueryClaim, queryContractDigest } from "../../src/index.js";
import { adapter, evidence, fixture, hash, owner } from "./live-fixture.js";
export const schema = { formatVersion: 1, dialect: "vendor/live", tables: {} } as const;
export const context = {
  ...fixture().staticClaim.context,
  schemaHash: calculateSchemaHash(schema),
  typePolicyHash: calculateTypePolicyHash({}),
};
export const configuration = {
  mode: "offline" as const,
  context,
  identity: {
    profileHash: context.profileHash,
    codecHash: context.codecHash,
    interpreterHash: context.interpreterHash,
  },
  qualification: fixture().policy,
  cache: { adapter: evidence.adapter, connectionContext: hash },
};
export const profile = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "vendor/live",
  grammarVersion: "1",
  sqlModule: "vendor/live",
  capabilities: {},
  defaultTypePolicy: {},
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => name,
  validateSnapshot: () => schema,
};
const base = fixture();
const { digest: _, ...original } = base.staticClaim;
const claim = { ...original, context };
export const request = {
  ...base,
  staticClaim: parseStaticQueryClaim({ ...claim, digest: queryContractDigest(claim) }),
};
export const native = createNativeLiveAnalysisRunner({
  adapter: adapter({
    open: async () => ({ context: async () => context, describe: async () => evidence, close: async () => {} }),
  }),
  contribution: owner,
});
export const result = await native(request, new AbortController().signal);
if (result.kind !== "usable-recorded-context") throw Error("Fixture qualification failed");
export const contract = result.contract;
