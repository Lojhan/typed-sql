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

export function recognitionQueries(row: DiscoveredFunction) {
  if (!/^[a-z_][a-z_0-9]*$/iu.test(row.name) || row.kind === "p" || row.result_type_kind === "p") return [];
  const types = Array.isArray(row.argument_types)
    ? row.argument_types
    : Array.isArray(row.arguments)
      ? row.arguments
      : undefined;
  if (types?.some((type) => typeof type !== "string" || !/^[a-z_0-9 "[\](),.]+$/iu.test(type))) return [];
  const arity = Number(row.arity);
  const counts = types ? [types.length] : Number.isSafeInteger(arity) && arity >= 0 ? [arity] : [0, 1, 2, 3, 4, 5];
  return counts
    .filter((count) => count <= 128)
    .map((count) => {
      const argumentsSql = types
        ? types.map((type) => `CAST(${/\[\]$/u.test(type) ? "[0.5]" : "NULL"} AS ${type})`).join(", ")
        : Array(count).fill("NULL").join(", ");
      const namespace = row.namespace && /^[a-z_][a-z_0-9]*$/iu.test(row.namespace) ? `${row.namespace}.` : "";
      const call = `${namespace}${row.name}(${argumentsSql})`;
      if (["table", "table_macro", "IF", "TF", "FT"].includes(row.kind ?? "") || row.returns_set)
        return `SELECT * FROM ${call}`;
      return `SELECT ${call}${row.kind === "window" || row.kind === "w" ? " OVER ()" : ""} AS value`;
    });
}
