export type DiscoveredFunction = {
  name: string;
  kind?: string;
  arity?: number;
  arguments?: unknown;
  argument_types?: unknown;
  result_type_kind?: string;
  namespace?: string;
  returns_set?: boolean;
};

export interface CallProbePolicy {
  kind(row: DiscoveredFunction): "scalar" | "window" | "table" | "unavailable";
  typedArgument(type: string, nextParameter: () => number): string;
  inferredArguments?: (count: number) => string[];
}

/** Shared SQL-call assembly; owners supply native kind meanings and argument syntax. */
export function callProbeQueries(row: DiscoveredFunction, policy: CallProbePolicy) {
  const kind = policy.kind(row);
  if (!/^[a-z_][a-z_0-9]*$/iu.test(row.name) || kind === "unavailable") return [];
  const types = Array.isArray(row.argument_types)
    ? row.argument_types
    : Array.isArray(row.arguments)
      ? row.arguments
      : undefined;
  if (types?.some((type) => typeof type !== "string" || !/^[a-z_0-9 "[\](),.]+$/iu.test(type))) return [];
  const arity = Number(row.arity);
  // Name-only references are recognition attempts, never signature or support evidence.
  const counts = types ? [types.length] : Number.isSafeInteger(arity) && arity >= 0 ? [arity] : [0, 1, 2, 3, 4, 5];
  const namespace = row.namespace && /^[a-z_][a-z_0-9]*$/iu.test(row.namespace) ? `${row.namespace}.` : "";
  const query = (args: string[]) => {
    const call = `${namespace}${row.name}(${args.join(", ")})`;
    return kind === "table" ? `SELECT * FROM ${call}` : `SELECT ${call}${kind === "window" ? " OVER ()" : ""} AS value`;
  };
  return counts
    .filter((count) => count <= 128)
    .flatMap((count) => {
      let parameter = 0;
      const args = types
        ? types.map((type) => `CAST(${policy.typedArgument(type, () => ++parameter)} AS ${type})`)
        : Array<string>(count).fill("NULL");
      const sql = query(args);
      return types?.length && policy.inferredArguments ? [sql, query(policy.inferredArguments(count))] : [sql];
    });
}

/** Compatibility for callers supplying neutral routine kinds without a registered grammar. */
export const neutralCallProbes: CallProbePolicy = {
  kind: (row) => (row.returns_set || row.kind === "table" ? "table" : row.kind === "window" ? "window" : "scalar"),
  typedArgument: () => "NULL",
};
