import type { ResolvedColumn, ResolvedParameter, SqlDiagnostic } from "../../packages/core/src/index.js";
import type {
  DescriptionScope,
  NativeDescription,
  NativeTypeDescriptor,
  NativeTypeOracle,
} from "./native-description/contracts.js";

interface AnalyzedDescription {
  columns: readonly ResolvedColumn[];
  parameters: readonly ResolvedParameter[];
  diagnostics: readonly SqlDiagnostic[];
}

interface ClaimEvidence {
  position: string;
  databaseType: string;
  nativeClaim?: NativeTypeDescriptor;
  expectedIdentity?: string;
  claimedIdentity?: string;
  reason?: string;
}

/** Native describes both the original expression and each claimed type. No host parser is an oracle. */
export async function compareNativeDescription(
  metadata: unknown,
  result: AnalyzedDescription,
  oracle: NativeTypeOracle | undefined,
) {
  const differences: string[] = [];
  const claims: ClaimEvidence[] = [];
  const unverified = (reason: string) => ({ status: "unverified", reason, differences, claims });
  if (!oracle) return unverified("No independent native type-description mapper");
  if (!metadata || typeof metadata !== "object") return unverified("Native result description unavailable");
  if (result.diagnostics.length) return unverified("Grammar diagnostics retained in the audit");
  if (!result.columns.length) return unverified("Grammar result shape unavailable");
  const native = metadata as NativeDescription;
  if (!Array.isArray(native.columns)) return unverified("Native result type description unavailable");
  let incomplete = false;
  async function compare(
    expected: NativeTypeDescriptor,
    actual: ResolvedColumn | ResolvedParameter | undefined,
    scope: DescriptionScope,
    position: string,
  ) {
    if (!actual?.databaseType || actual.tsType === "unknown" || actual.tsType === "any") {
      incomplete = true;
      return;
    }
    const resolution = await oracle!.resolve(actual.databaseType);
    const expectedIdentity = oracle!.identity(expected, scope);
    const claimedIdentity = resolution.descriptor ? oracle!.identity(resolution.descriptor, scope) : undefined;
    claims.push({
      position,
      databaseType: actual.databaseType,
      ...(resolution.descriptor ? { nativeClaim: resolution.descriptor } : {}),
      ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
      ...(claimedIdentity === undefined ? {} : { claimedIdentity }),
      ...(resolution.reason ? { reason: resolution.reason } : {}),
    });
    if (expectedIdentity === undefined || claimedIdentity === undefined) {
      incomplete = true;
      return;
    }
    if (claimedIdentity !== expectedIdentity)
      differences.push(
        `${position}: grammar ${actual.databaseType}; engine ${expected.nativeType ?? expectedIdentity}`,
      );
  }
  if (native.columns.length !== result.columns.length) differences.push("Result column count differs");
  for (const [index, column] of native.columns.entries())
    await compare(column, result.columns[index], "column", `Column ${index + 1}`);
  if (native.parameterCount == null) incomplete = true;
  else if (native.parameterCount !== result.parameters.length)
    differences.push(`Parameter count: grammar ${result.parameters.length}; engine ${native.parameterCount}`);
  const described = new Set<number>();
  for (const parameter of native.parameters ?? []) {
    if (described.has(parameter.index)) {
      incomplete = true;
      continue;
    }
    described.add(parameter.index);
    const actual = result.parameters.find((value) => value.index === parameter.index);
    await compare(parameter, actual, "parameter", `Parameter ${parameter.index}`);
  }
  if (result.parameters.some((parameter) => !described.has(parameter.index))) incomplete = true;
  return {
    status: differences.length ? "mismatch" : incomplete ? "unverified" : "native-identities-match",
    differences,
    claims,
  };
}
