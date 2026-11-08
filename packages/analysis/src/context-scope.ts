import { canonicalContractData, queryContractDigest } from "./canonical.js";
import { parseQueryContractContext, type QueryContractContext } from "./contracts.js";

/** Independently configured target and installed semantic identities; excludes the observed DB epoch. */
export interface AnalysisContextScope extends Omit<QueryContractContext, "databaseContextHash"> {
  readonly connectionContext: string;
  readonly adapter: { readonly id: string; readonly version: string };
}
export function parseAnalysisContextScope(input: AnalysisContextScope): AnalysisContextScope {
  const value = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "adapter,codecHash,connectionContext,grammar,interpreterHash,profileHash,schemaHash,typePolicyHash" ||
    typeof value.connectionContext !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.connectionContext) ||
    !value.adapter ||
    typeof value.adapter !== "object" ||
    Array.isArray(value.adapter) ||
    Object.keys(value.adapter).sort().join(",") !== "id,version" ||
    Object.values(value.adapter).some((part) => typeof part !== "string" || !part.length || part.length > 4096)
  )
    throw new TypeError("Invalid analysis context scope");
  const { adapter, connectionContext, ...staticContext } = value;
  const { databaseContextHash: _, ...normalized } = parseQueryContractContext({
    ...staticContext,
    databaseContextHash: "0".repeat(64),
  });
  return Object.freeze({ ...normalized, connectionContext, adapter: Object.freeze(adapter) });
}
export function analysisContextScopeKey(scope: AnalysisContextScope): string {
  return queryContractDigest({ selection: "analysis-context-v1", scope });
}
export function assertContextScope(context: QueryContractContext, scope: AnalysisContextScope): void {
  const { databaseContextHash: _, ...actual } = context;
  const { adapter: _adapter, connectionContext: _connection, ...expected } = scope;
  if (canonicalContractData(actual) !== canonicalContractData(expected))
    throw new TypeError("Observed context differs from the installed profile, schema or decoding policy");
}
