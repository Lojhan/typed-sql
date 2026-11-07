import type { InvocationShapeSyntax } from "../invocation-shapes.js";
import type { DiscoveredFunction } from "../invocations.js";

interface SqlShapePolicy {
  quote(name: string): string;
  named(name: string, value: string): string;
  kind(row: DiscoveredFunction): "scalar" | "table" | "window" | "unavailable";
  dynamicType?(identity: string): boolean;
  sample?(identity: string): string;
  variadicPrefix?: string;
  parameterRoleLimitation?: InvocationShapeSyntax["parameterRoleLimitation"];
  rejection?: InvocationShapeSyntax["rejection"];
}
/** SQL-family mechanics only; registered owners supply syntax, categories and type policy. */
export function sqlInvocationShapeSyntax(policy: SqlShapePolicy): InvocationShapeSyntax {
  return {
    call(row, args) {
      const kind = policy.kind(row);
      if (kind === "unavailable") return undefined;
      const callee = [row.namespace, row.name]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .map(policy.quote)
        .join(".");
      const call = `${callee}(${args.join(", ")})`;
      return kind === "table"
        ? `SELECT * FROM ${call}`
        : `SELECT ${call}${kind === "window" ? " OVER ()" : ""} AS value`;
    },
    named: policy.named,
    ...(policy.parameterRoleLimitation ? { parameterRoleLimitation: policy.parameterRoleLimitation } : {}),
    rejection: policy.rejection ?? (() => "unclassified"),
    value(type, mode) {
      let value: string;
      if (type.kind === "unknown") value = "NULL";
      else if (type.kind !== "native") return undefined;
      else if (policy.dynamicType?.(type.identity)) value = "NULL";
      else {
        if (!/^[a-z_0-9 "[\](),.]+$/iu.test(type.identity)) return undefined;
        value = `CAST(${policy.sample?.(type.identity) ?? "NULL"} AS ${type.identity})`;
      }
      return mode === "variadic" && policy.variadicPrefix ? `${policy.variadicPrefix}${value}` : value;
    },
  };
}
