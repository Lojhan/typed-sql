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
): QueryValuePlan {
  const descriptor = (
    value: (typeof analysis.columns)[number] | (typeof analysis.parameters)[number],
  ): QueryValueDescriptor => ({
    type: value.runtimeType ?? dialect.runtimeValueType?.(value, policy) ?? "unknown",
    nullable: value.nullable,
    ...(value.json === undefined ? {} : { json: value.json }),
    ...(value.scalarJsonShape === undefined ? {} : { scalarJsonShape: value.scalarJsonShape }),
  });
  return {
    dialect: dialect.id,
    typePolicyHash: calculateTypePolicyHash(policy),
    columns: analysis.columns.map((column) => ({ ...descriptor(column), name: column.name })),
    parameters: [...analysis.parameters]
      .sort((left, right) => left.index - right.index)
      .map((parameter) => ({ ...descriptor(parameter), index: parameter.index })),
  };
}
