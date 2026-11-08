import {
  type DialectAnalysis,
  type DialectPlugin,
  type DialectProfile,
  type SchemaSnapshot,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { canonicalContractData } from "./canonical.js";
import {
  createQueryContractIndex,
  parseQueryContractContext,
  type QueryContract,
  type QueryContractContext,
} from "./contracts.js";
import { nativeContractParametersAvailable } from "./native-evidence.js";
import { contractTypeScriptType } from "./runtime-type.js";

export type ContractGrammarProfile<Snapshot extends SchemaSnapshot, Policy> = DialectProfile<Snapshot, Policy>;

/** A synchronous frozen consumer. No native client or full analyzer is imported or invoked. */
export function createContractDialect<Snapshot extends SchemaSnapshot, Policy>(input: {
  readonly profile: ContractGrammarProfile<Snapshot, Policy>;
  readonly context: QueryContractContext;
  readonly contracts: readonly QueryContract[];
  readonly qualificationPolicyHash?: string;
}): DialectPlugin<Snapshot, Policy> {
  const { profile } = input,
    context = parseQueryContractContext(input.context),
    index = createQueryContractIndex(input.contracts);
  if (input.qualificationPolicyHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.qualificationPolicyHash))
    throw new TypeError("Invalid required qualification policy hash");
  if (Object.hasOwn(profile, "analyze")) throw new TypeError("Contract profiles must not contain an eager analyzer");
  if (profile.id !== context.grammar.id || profile.grammarVersion !== context.grammar.version)
    throw new TypeError("Contract profile identity mismatch");
  return Object.freeze({
    ...profile,
    analyze(sql, schema, policy = profile.defaultTypePolicy, analysisContext): DialectAnalysis {
      const range = { start: 0, end: sql.length, line: 1, column: 1 };
      const unavailable = (message: string): DialectAnalysis => ({
        columns: [],
        parameters: [],
        diagnostics: [
          {
            code: "TSQ406",
            severity: "error",
            message,
            range,
            suggestion: "Generate a matching query contract for the selected schema, context and decoding policy.",
          },
        ],
        semantics: unknownQuerySemantics(range, message),
      });
      if (
        schema.dialect !== profile.id ||
        calculateSchemaHash(schema) !== context.schemaHash ||
        calculateTypePolicyHash(policy ?? {}) !== context.typePolicyHash
      )
        return unavailable("Query contract schema or decoding policy does not match");
      if (analysisContext?.repeatedFragmentRanges?.length)
        return unavailable("Query contract does not establish repeated-result invariance");
      const contract = index.resolve(context, sql);
      if (!contract) return unavailable("No matching query contract");
      if (
        input.qualificationPolicyHash !== undefined &&
        contract.qualification?.policyHash !== input.qualificationPolicyHash
      )
        return unavailable("Query contract does not meet the required qualification policy");
      if (contract.nativeEvidence) {
        if (!nativeContractParametersAvailable(contract.nativeEvidence))
          return unavailable("Native query contract parameter metadata is unresolved");
        const occurrences = profile.parameterOccurrences?.(sql, schema, policy);
        const layout = occurrences?.map(({ index, range }) => ({ index, start: range.start, end: range.end }));
        if (
          layout
            ? canonicalContractData(layout) !== canonicalContractData(contract.nativeEvidence.parameterOccurrences)
            : contract.nativeEvidence.parameterOccurrences.length > 0
        )
          return unavailable("Native query contract parameter layout does not match");
      }
      const sourceRange = (span: { readonly start: number; readonly end: number }) => {
        const prefix = sql.slice(0, span.start),
          line = prefix.split("\n").length,
          last = prefix.lastIndexOf("\n");
        return { ...span, line, column: span.start - last };
      };
      return {
        columns: contract.valuePlan.columns.map((column, position) => ({
          ...column,
          tsType: contractTypeScriptType(column),
          runtimeType: column.type,
          ...(contract.nativeEvidence?.columns[position]?.nativeType.status === "known" &&
          !contract.nativeEvidence.columns[position]!.nativeType.value.complete
            ? { databaseTypeIsPartial: true as const }
            : {}),
          range: sourceRange(contract.columnSpans[position]!),
        })),
        parameters: contract.valuePlan.parameters.map((parameter, position) => ({
          ...parameter,
          tsType: contractTypeScriptType(parameter),
          runtimeType: parameter.type,
          ...(contract.nativeEvidence?.parameters[position]?.nativeType.status === "known" &&
          !contract.nativeEvidence.parameters[position]!.nativeType.value.complete
            ? { databaseTypeIsPartial: true as const }
            : {}),
        })),
        ...(contract.nativeEvidence ? { resultKind: contract.nativeEvidence.resultKind } : {}),
        diagnostics: [],
        semantics: unknownQuerySemantics(range, "Query contract does not establish execution effects or cardinality"),
      };
    },
  });
}
