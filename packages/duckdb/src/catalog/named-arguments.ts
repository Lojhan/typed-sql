import { bindRoutineArguments } from "@typed-sql/core";
import { duckDBAsciiFold } from "../native-types.js";
import {
  duckDBBuiltinFormalNames,
  duckDBBuiltinSignatures,
  duckDBKeywordInvocationForms,
  duckDBNamedArgumentBinding,
} from "./index.js";

/** Native names bind slots; type selection and coercion remain in the DuckDB resolver. */
export function duckDBNamedArgumentOrder(
  version: string,
  name: string,
  names: readonly (string | undefined)[],
  quoted: boolean,
): readonly number[] | undefined {
  const policy = duckDBNamedArgumentBinding(version);
  if (
    !policy ||
    (!quoted && duckDBKeywordInvocationForms(version).includes(name) && !Object.hasOwn(policy.overrides, name))
  )
    return undefined;
  if ((policy.overrides as Readonly<Record<string, string>>)[name] === "labels") return names.map((_, index) => index);
  const orders = new Map<string, number[]>();
  for (const signature of duckDBBuiltinSignatures(version, name)) {
    if (names.length < signature[2].length || (!signature[4] && names.length !== signature[2].length)) continue;
    const mode =
      (policy.overrides as Readonly<Record<string, string>>)[name] ??
      (signature[1] === "macro" ? policy.macro : policy.scalar);
    if (mode === "labels") {
      const order = names.map((_, index) => index);
      orders.set(JSON.stringify(order), order);
      continue;
    }
    for (const alternative of duckDBBuiltinFormalNames(signature)) {
      if (alternative.length !== signature[2].length) continue;
      const slots = alternative.map((name) => ({
        ...(name === null ? {} : { name: duckDBAsciiFold(name) }),
        optional: false,
        variadic: false,
      }));
      if (signature[4]) slots.push({ optional: true, variadic: true });
      const binding = bindRoutineArguments(
        slots,
        {
          argumentCount: names.length,
          names: names.map((name) => (name === undefined ? undefined : duckDBAsciiFold(name))),
          variadic: "expanded",
        },
        { positionalAfterNamed: false, expandedVariadicNames: true, minimumVariadicElements: 0 },
      );
      if (!binding) continue;
      const order = binding
        .map((slot, index) => ({ parameter: slot.parameterIndex, index }))
        .sort((a, b) => a.parameter - b.parameter || a.index - b.index)
        .map((slot) => slot.index);
      orders.set(JSON.stringify(order), order);
    }
  }
  return orders.size === 1 ? orders.values().next().value : undefined;
}
