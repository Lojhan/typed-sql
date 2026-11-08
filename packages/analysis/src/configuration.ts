import { assertDialectProfile, type DialectPlugin, type DialectProfile, type SchemaSnapshot } from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { loadQueryContracts } from "./artifacts.js";
import { canonicalContractData, queryContractDigest } from "./canonical.js";
import { parseQueryContractContext, type QueryContract, type QueryContractContext } from "./contracts.js";
import { createContractDialect } from "./dialect.js";
import { type ContractQualificationPolicy, parseContractQualificationPolicy } from "./qualification-model.js";

export type AnalysisMode = "offline" | "frozen" | "live";
export interface ContractInterpreterIdentity {
  readonly profileHash: string;
  readonly codecHash: string;
  readonly interpreterHash: string;
}
export interface AnalysisConfiguration {
  readonly mode?: AnalysisMode;
  /** Pinned recorded database scope; this is not a claim about current remote freshness. */
  readonly context: QueryContractContext;
  /** Supplied by the installed owner/configuration, independently of the artifact being loaded. */
  readonly identity: ContractInterpreterIdentity;
  readonly qualification: ContractQualificationPolicy;
  readonly contractsDir?: string;
  readonly cache?: {
    readonly directory?: string;
    readonly connectionContext: string;
    readonly adapter: { readonly id: string; readonly version: string };
  };
}
export interface ResolvedAnalysisConfiguration extends AnalysisConfiguration {
  readonly mode: AnalysisMode;
}
/** Data-only configuration. Adapter and analyzer factories belong to explicit registration boundaries. */
export function defineAnalysisConfiguration(input: unknown): ResolvedAnalysisConfiguration {
  const value = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      [
        "context",
        "identity",
        "qualification",
        ...(Object.hasOwn(value, "mode") ? ["mode"] : []),
        ...(Object.hasOwn(value, "contractsDir") ? ["contractsDir"] : []),
        ...(Object.hasOwn(value, "cache") ? ["cache"] : []),
      ]
        .sort()
        .join(",")
  )
    throw new TypeError("Invalid analysis configuration fields");
  if (value.mode !== undefined && !["offline", "frozen", "live"].includes(value.mode))
    throw new TypeError("Invalid analysis mode");
  if (
    value.contractsDir !== undefined &&
    (typeof value.contractsDir !== "string" || !value.contractsDir.length || value.contractsDir.includes("\0"))
  )
    throw new TypeError("Invalid analysis contracts directory");
  const identity = value.identity;
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(",") !== "codecHash,interpreterHash,profileHash" ||
    Object.values(identity).some((item) => typeof item !== "string" || !/^[a-f0-9]{64}$/u.test(item))
  )
    throw new TypeError("Invalid analysis interpreter identity");
  const context = parseQueryContractContext(value.context),
    qualification = parseContractQualificationPolicy(value.qualification);
  if (value.cache !== undefined) {
    const cache = value.cache;
    if (
      !cache ||
      typeof cache !== "object" ||
      Array.isArray(cache) ||
      Object.keys(cache).sort().join(",") !==
        (Object.hasOwn(cache, "directory") ? "adapter,connectionContext,directory" : "adapter,connectionContext") ||
      typeof cache.connectionContext !== "string" ||
      !/^[a-f0-9]{64}$/u.test(cache.connectionContext) ||
      (cache.directory !== undefined &&
        (typeof cache.directory !== "string" || !cache.directory.length || cache.directory.includes("\0"))) ||
      !cache.adapter ||
      typeof cache.adapter !== "object" ||
      Array.isArray(cache.adapter) ||
      Object.keys(cache.adapter).sort().join(",") !== "id,version" ||
      Object.values(cache.adapter).some((item) => typeof item !== "string" || !item.length || item.length > 4096)
    )
      throw new TypeError("Invalid analysis cache configuration");
    Object.freeze(cache.adapter);
    Object.freeze(cache);
  }
  for (const key of ["profileHash", "codecHash", "interpreterHash"] as const)
    if (context[key] !== identity[key])
      throw new TypeError(`Recorded analysis ${key} differs from the configured interpreter`);
  return Object.freeze({
    ...value,
    mode: value.mode ?? "offline",
    context,
    qualification,
    identity: Object.freeze(identity),
  });
}

/** Loads only declared durable inputs. It never opens cache storage or initializes an owner. */
export async function loadFrozenContractView<Snapshot extends SchemaSnapshot, Policy>(input: {
  readonly profile: DialectProfile<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly configuration: AnalysisConfiguration;
  readonly directory: string;
}): Promise<{
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly contracts: readonly QueryContract[];
  readonly digest: string;
}> {
  const configuration = defineAnalysisConfiguration(input.configuration),
    profile = input.profile;
  assertDialectProfile(profile);
  if ("analyze" in profile)
    throw new TypeError("Frozen checking requires a profile registration, without an eager analyzer");
  const context = configuration.context,
    policy = input.typePolicy ?? profile.defaultTypePolicy;
  if (
    context.grammar.id !== profile.id ||
    context.grammar.version !== profile.grammarVersion ||
    context.schemaHash !== calculateSchemaHash(input.schema) ||
    context.typePolicyHash !== calculateTypePolicyHash(policy ?? {})
  )
    throw new TypeError("Frozen analysis profile, schema or decoding policy differs");
  const contracts = await loadQueryContracts(input.directory),
    policyHash = queryContractDigest(configuration.qualification);
  for (const contract of contracts)
    if (contract.origin !== "offline-rule" || configuration.qualification.mode === "native-required") {
      if (contract.qualification?.policyHash !== policyHash)
        throw new TypeError("Durable query contract does not meet the configured qualification policy");
    }
  const dialect = createContractDialect({
    profile,
    context,
    contracts,
    ...(configuration.qualification.mode === "native-required" ? { qualificationPolicyHash: policyHash } : {}),
  });
  return Object.freeze({
    dialect,
    contracts,
    digest: queryContractDigest(contracts.map((item) => item.digest).sort()),
  });
}
