import type {
  DialectAnalysis,
  DialectPlugin,
  QueryValueDescriptor,
  QueryValuePlan,
  SchemaSnapshot,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";

/** Build-time metadata. SQL meaning and logical scalar conversions remain grammar-owned. */
export function buildQueryValuePlan<Snapshot extends SchemaSnapshot, Policy>(
  dialect: DialectPlugin<Snapshot, Policy>,
  analysis: Pick<DialectAnalysis, "columns" | "parameters">,
  policy: Policy = dialect.defaultTypePolicy,
  parameterCount = Math.max(0, ...analysis.parameters.map((parameter) => parameter.index)),
): QueryValuePlan {
  const descriptor = (
    value: (typeof analysis.columns)[number] | (typeof analysis.parameters)[number],
  ): QueryValueDescriptor => ({
    type: value.runtimeType ?? dialect.runtimeValueType?.(value, policy) ?? "unknown",
    nullable: value.nullable,
    ...(value.json === undefined ? {} : { json: value.json }),
    ...(value.scalarJsonShape === undefined ? {} : { scalarJsonShape: value.scalarJsonShape }),
  });
  if (
    !Number.isSafeInteger(parameterCount) ||
    parameterCount < 0 ||
    parameterCount > 65_535 ||
    analysis.parameters.some(
      (parameter) => !Number.isSafeInteger(parameter.index) || parameter.index < 1 || parameter.index > parameterCount,
    )
  )
    throw new TypeError("Invalid executable query parameter count");
  const byIndex = new Map(analysis.parameters.map((parameter) => [parameter.index, parameter]));
  if (byIndex.size !== analysis.parameters.length) throw new TypeError("Duplicate executable query parameter index");
  return {
    dialect: dialect.id,
    typePolicyHash: calculateTypePolicyHash(policy),
    columns: analysis.columns.map((column) => ({ ...descriptor(column), name: column.name })),
    parameters: Array.from({ length: parameterCount }, (_, offset) => {
      const index = offset + 1;
      const parameter = byIndex.get(index);
      return parameter === undefined
        ? { index, type: "unknown" as const, nullable: true }
        : {
            ...descriptor(parameter),
            index,
            ...(parameter.acceptsJsonInput === true ? { acceptsJsonInput: true as const } : {}),
          };
    }),
  };
}
