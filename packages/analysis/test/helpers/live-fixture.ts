import { unknownQuerySemantics } from "../../../core/src/index.js";
import {
  type ContractReconciliationContribution,
  createNativeLiveAnalysisRunner,
  createStaticQueryClaim,
  type LiveAnalysisRequest,
  type NativeContractAdapter,
  type NativeQueryContractEvidence,
  queryContractDigest,
} from "../../src/index.js";

export const hash = queryContractDigest("fixture");
export const context = {
  grammar: { id: "vendor/live", version: "1" },
  profileHash: hash,
  schemaHash: hash,
  databaseContextHash: hash,
  typePolicyHash: hash,
  codecHash: hash,
  interpreterHash: hash,
};
export const evidence: NativeQueryContractEvidence = {
  adapter: { id: "vendor/native", version: "1" },
  consistency: { mechanism: "snapshot", scope: "fixture" },
  resultKind: "rows",
  parameters: [],
  parameterOccurrences: [],
  columns: [
    {
      name: "value",
      nativeType: { status: "known", value: { name: "integer", complete: true } },
      runtimeType: { status: "known", value: "number" },
      nullable: { status: "known", value: false, precision: "exact" },
      descriptor: {},
    },
  ],
};
export const owner: ContractReconciliationContribution = {
  id: "vendor/reconciliation",
  version: "1",
  grammar: context.grammar,
  classify: () => ({ status: "resolved", rule: "fixture", reason: "Independent fixture" }),
  compare: () => ({ status: "compatible", staticStatus: "known", rule: "fixture", reason: "Equal fixture facts" }),
};
export function fixture(sql = "SELECT 1 AS value", connectionContext = hash): LiveAnalysisRequest {
  const range = { start: 0, end: sql.length, line: 1, column: 1 };
  return {
    connectionContext,
    adapter: evidence.adapter,
    candidate: { sql, parameterOccurrences: [], columnSpans: [{ start: 7, end: 8 }] },
    staticClaim: createStaticQueryClaim({
      sql,
      context,
      analysis: {
        columns: [
          { name: "value", tsType: "number", runtimeType: "number", databaseType: "integer", nullable: false, range },
        ],
        parameters: [],
        diagnostics: [],
        resultKind: "rows",
        semantics: unknownQuerySemantics(range, "fixture"),
      },
    }),
    policy: {
      mode: "native-required",
      owner: { id: owner.id, version: owner.version },
      requiredNativeFacets: ["runtime-type"],
    },
  };
}
export function adapter(patch: Partial<NativeContractAdapter> = {}): NativeContractAdapter {
  return {
    ...evidence.adapter,
    grammar: context.grammar,
    accept: () => ({ accepted: true }),
    open: async () => ({ context: async () => context, describe: async () => evidence, close: async () => {} }),
    ...patch,
  };
}
export const runner = createNativeLiveAnalysisRunner({ adapter: adapter(), contribution: owner });
